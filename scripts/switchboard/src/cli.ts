import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { createMeridianProgram, findConfigPda, MERIDIAN_PROGRAM_ID } from "@meridian/client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  DEFAULT_DEVNET_RPC,
  DEVNET_QUEUE,
  assertDevnet,
  createFeeds,
  feedAccountsJson,
  liveSimulator,
  parseFeedAccounts,
  sdkClient,
  type SwitchboardClient,
} from "./devnet";
import { checkFeeds, configReaderFromProgram, type ConfigReader } from "./check";
import { SOURCE_KEY_VARIABLE, SOURCES, TICKERS, loadFeedDefinitions } from "./feeds";
import { feedsFileJson, parseFeedsFile, type FeedsFile } from "./feedsFile";
import { fixtureSimulator, loadFixture } from "./fixtures";
import { computeFeedHash, runSpike } from "./spike";

/** Repository root (this file is scripts/switchboard/src/cli.ts). */
export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
export const DEFAULT_FEEDS_DIR = resolve(REPO_ROOT, "oracle/feeds");
export const DEFAULT_FIXTURE = resolve(REPO_ROOT, "scripts/switchboard/fixtures/spike.json");
export const DEFAULT_FEEDS_FILE = resolve(REPO_ROOT, "deployments/feeds.devnet.json");
export const DEFAULT_DEPLOYMENT_RECORD = resolve(REPO_ROOT, "deployments/devnet.json");

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_BLOCKED = 2;

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** Live-mode effects, injectable for tests. */
export interface LiveDeps {
  connect(rpc: string): Connection;
  loadKeypair(path: string): Keypair;
  client(connection: Connection, payer: Keypair): Promise<SwitchboardClient>;
  /** Reads the feeds pinned in Config (a read-only view, no signer needed). */
  config(connection: Connection, programId: PublicKey): ConfigReader;
}

export const defaultLiveDeps: LiveDeps = {
  connect: (rpc) => new Connection(rpc, "confirmed"),
  loadKeypair: (path) => {
    const bytes: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b))) {
      throw new Error(`${path} is not a Solana keypair file`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  },
  client: sdkClient,
  config: (connection, programId) =>
    configReaderFromProgram(
      createMeridianProgram(
        new AnchorProvider(connection, new Wallet(Keypair.generate()), { commitment: "confirmed" }),
        programId,
      ),
      findConfigPda(programId).address,
    ),
};

interface Options {
  readonly dryRun: boolean;
  readonly feedsDir: string;
  readonly fixture: string;
  readonly rpc: string;
  readonly keypair: string;
  readonly queue: PublicKey;
  /** Where `create-feeds` writes the feeds file; `check-feeds` reads `feedsFile`. */
  readonly out: string | undefined;
  readonly feedsFile: string;
  readonly programId: string | undefined;
}

class UsageError extends Error {}

function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "dry-run": { type: "boolean", default: false },
      cluster: { type: "string", default: "devnet" },
      "feeds-dir": { type: "string", default: DEFAULT_FEEDS_DIR },
      fixture: { type: "string", default: DEFAULT_FIXTURE },
      rpc: { type: "string", default: DEFAULT_DEVNET_RPC },
      keypair: { type: "string", default: resolve(homedir(), ".config/solana/id.json") },
      out: { type: "string" },
      "feeds-file": { type: "string", default: DEFAULT_FEEDS_FILE },
      "program-id": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.cluster !== "devnet") {
    throw new UsageError(`--cluster ${values.cluster} is not supported: devnet only (D-012)`);
  }
  const queue = env["SWITCHBOARD_QUEUE"]?.trim();
  return {
    dryRun: values["dry-run"],
    feedsDir: values["feeds-dir"],
    fixture: values.fixture,
    rpc: values.rpc,
    keypair: values.keypair,
    queue: queue === undefined || queue.length === 0 ? DEVNET_QUEUE : new PublicKey(queue),
    out: values.out,
    feedsFile: values["feeds-file"],
    programId: values["program-id"],
  };
}

/**
 * The API keys as `variableOverrides`, or the names of the missing ones. `.env.example`
 * placeholders (`test-…`) count as missing.
 */
export function keyOverrides(
  env: NodeJS.ProcessEnv,
): { ok: true; overrides: Record<string, string> } | { ok: false; missing: string[] } {
  const names = SOURCES.map((source) => SOURCE_KEY_VARIABLE[source]);
  const missing = names.filter((name) => {
    const value = env[name]?.trim() ?? "";
    return value.length === 0 || value.startsWith("test-");
  });
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, overrides: Object.fromEntries(names.map((n) => [n, env[n]?.trim() ?? ""])) };
}

async function guarded(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(JSON.stringify({ level: "error", message }));
    return error instanceof UsageError ? EXIT_BLOCKED : EXIT_FAILED;
  }
}

async function liveSession(options: Options, deps: LiveDeps) {
  const connection = deps.connect(options.rpc);
  await assertDevnet(connection);
  const payer = deps.loadKeypair(options.keypair);
  return { connection, payer, client: await deps.client(connection, payer) };
}

/**
 * `spike.ts`: simulate one oracle update per feed definition and print feed hash, value, slot
 * and per-oracle results. `--dry-run` uses fixtures and no network; otherwise devnet with keys.
 */
export function spikeMain(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: LiveDeps = defaultLiveDeps,
): Promise<number> {
  return guarded(io, async () => {
    const options = parseOptions(argv, env);
    const defs = loadFeedDefinitions(options.feedsDir);
    let simulator;
    if (options.dryRun) {
      simulator = fixtureSimulator(loadFixture(options.fixture));
    } else {
      const keys = keyOverrides(env);
      if (!keys.ok) {
        io.err(`blocked: needs keys (${keys.missing.join(", ")})`);
        return EXIT_BLOCKED;
      }
      const feeds = parseFeedAccounts(env["SWITCHBOARD_FEEDS_JSON"]);
      const { client } = await liveSession(options, deps);
      simulator = liveSimulator({ client, feeds, variableOverrides: keys.overrides });
    }
    const mode = options.dryRun ? "dry-run" : "devnet";
    const report = await runSpike({ mode, queue: options.queue, defs, simulator });
    io.out(JSON.stringify(report, null, 2));
    return report.ok ? EXIT_OK : EXIT_FAILED;
  });
}

/**
 * `create-feeds.ts`: store each definition's jobs on Crossbar and create its PullFeed account on
 * devnet, printing feed pubkeys and hashes. `--dry-run` prints the feed hashes only.
 */
export function createFeedsMain(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: LiveDeps = defaultLiveDeps,
): Promise<number> {
  return guarded(io, async () => {
    const options = parseOptions(argv, env);
    const defs = loadFeedDefinitions(options.feedsDir);
    const feedHash = (def: (typeof defs)[number]) => computeFeedHash(options.queue, def);
    if (options.dryRun) {
      const plan = defs.map((def) => ({
        ticker: def.ticker,
        source: def.source,
        name: def.name,
        feedHash: feedHash(def),
      }));
      io.out(
        JSON.stringify({ mode: "dry-run", queue: options.queue.toBase58(), feeds: plan }, null, 2),
      );
      return EXIT_OK;
    }
    const { client } = await liveSession(options, deps);
    const created = await createFeeds({ client, queue: options.queue, defs, feedHash });
    io.out(
      JSON.stringify({ mode: "devnet", queue: options.queue.toBase58(), feeds: created }, null, 2),
    );
    io.out(`SWITCHBOARD_FEEDS_JSON=${feedAccountsJson(created)}`);
    if (options.out !== undefined) {
      // Public data only (feed accounts and hashes); the input of `deploy-devnet --feeds`.
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, feedsFileJson(created));
      io.out(`wrote the feeds file (${TICKERS.length * SOURCES.length} feeds) to the --out path`);
    }
    return EXIT_OK;
  });
}

/** The program ID for reading Config: `--program-id`, else the deployment record, else the IDL's. */
function programIdFor(options: Options): PublicKey {
  if (options.programId !== undefined) {
    return new PublicKey(options.programId);
  }
  try {
    const record: unknown = JSON.parse(readFileSync(DEFAULT_DEPLOYMENT_RECORD, "utf8"));
    const id = (record as { programId?: unknown }).programId;
    if (typeof id === "string") {
      return new PublicKey(id);
    }
  } catch {
    // No record yet: fall through.
  }
  return MERIDIAN_PROGRAM_ID;
}

/**
 * `check-feeds.ts` (M2-02): simulate an update of every feed and check that the 14 feeds are the
 * ones in `oracle/feeds`, exist, are the ones pinned in Config, and that the two sources of each
 * ticker agree within 0.05%. Prints a JSON report (value, slot, per-oracle results; no secrets)
 * and exits non-zero naming the ticker of every problem. `--dry-run` simulates from fixtures,
 * offline, and skips the account and Config checks.
 */
export function checkFeedsMain(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  deps: LiveDeps = defaultLiveDeps,
): Promise<number> {
  return guarded(io, async () => {
    const options = parseOptions(argv, env);
    const defs = loadFeedDefinitions(options.feedsDir);
    let file: FeedsFile | undefined;
    try {
      file = parseFeedsFile(readFileSync(options.feedsFile, "utf8"), "the feeds file");
    } catch (error) {
      if (!options.dryRun) {
        throw error;
      }
    }
    let report;
    if (options.dryRun) {
      report = await checkFeeds({
        mode: "dry-run",
        queue: options.queue,
        defs,
        file,
        simulator: fixtureSimulator(loadFixture(options.fixture)),
      });
    } else {
      const keys = keyOverrides(env);
      if (!keys.ok) {
        io.err(`blocked: needs keys (${keys.missing.join(", ")})`);
        return EXIT_BLOCKED;
      }
      if (file === undefined) {
        throw new UsageError("the feeds file is required for a live check");
      }
      const { connection, client } = await liveSession(options, deps);
      const accounts = Object.fromEntries(
        TICKERS.map((ticker) => [
          ticker,
          (file?.[ticker] ?? []).map((pin) => new PublicKey(pin.pubkey)),
        ]),
      );
      const programId = programIdFor(options);
      report = await checkFeeds({
        mode: "devnet",
        queue: options.queue,
        defs,
        file,
        accounts: client,
        config: deps.config(connection, programId),
        simulator: liveSimulator({ client, feeds: accounts, variableOverrides: keys.overrides }),
      });
    }
    io.out(JSON.stringify(report, null, 2));
    for (const failure of report.failures) {
      io.err(`FAIL ${failure}`);
    }
    return report.ok ? EXIT_OK : EXIT_FAILED;
  });
}

/** Console Io for the entry points. */
export const consoleIo: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};
