import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertCluster, findConfigPda, redactRpcUrl } from "@meridian/client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { computeFeedHash, loadFeedDefinitions } from "switchboard-scripts";

import { assertNoLocalOracle, sha256Hex } from "./artifacts";
import {
  createProgram,
  createUsdcMint,
  readOnChainConfig,
  sendConfigStep,
  verifyMint,
} from "./chain-io";
import { assertConfigAdmin, isPlaceholderPin, type OnChainConfig, planConfig } from "./config-plan";
import {
  assertHashesMatchDefinitions,
  bytesToHex,
  type FeedsByTicker,
  readFeedsFile,
  SOURCE_ORDER,
  TICKER_ORDER,
} from "./feeds-file";
import { readKeypairFile } from "./keypair";
import type { Options } from "./options";
import { runCommand } from "./process";
import { type DeploymentRecord, readRecord, writeRecord } from "./record";
import { assertProgramIds, declaredIdFromLibRs, idlAddress } from "./program-id";
import { feedAccountHash, isSwitchboardOwner } from "./switchboard";
import {
  BPF_LOADER_UPGRADEABLE,
  onChainElfMatches,
  onChainWindow,
  programDataAddress,
  programDataHeader,
} from "./upgradeable";

export type DeployResult = {
  /** What this run changed on chain, in order; empty on an idempotent re-run. */
  readonly actions: readonly string[];
  readonly record: DeploymentRecord;
};

/** Extra room above the first build's size so later, larger upgrades still fit. */
const MAX_LEN_FACTOR_NUM = 115n;
const MAX_LEN_FACTOR_DEN = 100n;

type Context = {
  readonly options: Options;
  readonly connection: Connection;
  readonly admin: Keypair;
  readonly programId: PublicKey;
  readonly log: (line: string) => void;
  readonly actions: string[];
  readonly runSolana: RunSolana;
};

/** Runs the `solana` CLI with these arguments (injectable so tests can observe every call). */
export type RunSolana = (args: readonly string[]) => Promise<void>;

export type DeployDeps = { readonly runSolana?: RunSolana };

/** The default `runSolana`: output is redacted so the RPC URL never reaches a log or an error. */
function defaultRunSolana(options: Options): RunSolana {
  return async (args) => {
    await runCommand("solana", args, {
      cwd: options.repoRoot,
      redact: (text) => redactRpcUrl(text, options.rpcUrl),
    });
  };
}

async function expectedFeedHashes(options: Options): Promise<Map<string, string>> {
  if (options.queue === undefined) {
    throw new Error("--feeds needs the Switchboard queue: set SWITCHBOARD_QUEUE or pass --queue");
  }
  const defs = loadFeedDefinitions(join(options.repoRoot, "oracle", "feeds"));
  const out = new Map<string, string>();
  for (const def of defs) {
    out.set(`${def.ticker}.${def.source}`, computeFeedHash(options.queue, def));
  }
  return out;
}

/** Loads and validates `--feeds` completely before anything is sent. */
async function loadFeeds(options: Options, connection: Connection): Promise<FeedsByTicker> {
  if (options.feedsPath === undefined) {
    throw new Error("internal: loadFeeds without --feeds");
  }
  const feeds = readFeedsFile(options.feedsPath);
  const hashes = await expectedFeedHashes(options);
  assertHashesMatchDefinitions(feeds, (ticker, index) => {
    const hash = hashes.get(`${ticker}.${SOURCE_ORDER[index]}`);
    if (hash === undefined) {
      throw new Error(`no feed definition for ${ticker}.${SOURCE_ORDER[index]} in oracle/feeds`);
    }
    return hash;
  });
  const order: { label: string; pubkey: PublicKey }[] = [];
  for (const ticker of TICKER_ORDER) {
    for (const index of [0, 1] as const) {
      const pin = feeds.get(ticker)?.[index];
      if (pin !== undefined) {
        order.push({ label: `${ticker}.${SOURCE_ORDER[index]}`, pubkey: pin.pubkey });
      }
    }
  }
  const pins = order.map((entry) => {
    const [ticker, source] = entry.label.split(".");
    const index = SOURCE_ORDER.findIndex((name) => name === source);
    const pin = feeds.get(ticker as (typeof TICKER_ORDER)[number])?.[index === 1 ? 1 : 0];
    return pin?.hash ?? new Uint8Array(32);
  });
  const infos = await connection.getMultipleAccountsInfo(
    order.map((entry) => entry.pubkey),
    "confirmed",
  );
  const bad = order
    .filter((_, i) => {
      const info = infos[i];
      return info === null || info === undefined || !isSwitchboardOwner(info.owner);
    })
    .map((entry) => `${entry.label} (${entry.pubkey.toBase58()})`);
  if (bad.length > 0) {
    throw new Error(
      `feed accounts that are missing or not owned by a Switchboard program: ${bad.join(", ")}. Nothing was sent.`,
    );
  }
  // Each account's own feed_hash must equal the hash being pinned: a swapped or wrong-queue pubkey
  // would otherwise only fail at settlement with OracleFeedHashMismatch.
  const wrongOwnHash = order
    .filter((_, i) => {
      const data = infos[i]?.data;
      const own = data === undefined ? null : feedAccountHash(data);
      const want = pins[i];
      return own === null || want === undefined || bytesToHex(own) !== bytesToHex(want);
    })
    .map((entry) => `${entry.label} (${entry.pubkey.toBase58()})`);
  if (wrongOwnHash.length > 0) {
    throw new Error(
      `feed accounts whose own feed_hash differs from the hash being pinned: ${wrongOwnHash.join(", ")}. Nothing was sent.`,
    );
  }
  return feeds;
}

async function ensureProgram(
  ctx: Context,
  soPath: string,
  expectedSha: string,
): Promise<PublicKey> {
  const { connection, admin, programId, options, log, actions, runSolana } = ctx;
  const elf = readFileSync(soPath);
  // The `.so` deployed is exactly the one verified after the build.
  if (sha256Hex(elf) !== expectedSha) {
    throw new Error(`${soPath} changed after it was verified; rebuild and run again`);
  }
  const info = await connection.getAccountInfo(programId, "confirmed");
  const common = [
    "--program-id",
    options.programKeypairPath,
    "--keypair",
    options.adminKeypairPath,
    "--upgrade-authority",
    options.adminKeypairPath,
    // The CLI never uses its own config (cluster, fee payer): the URL the guard validated and
    // the admin keypair are passed on every call.
    "--url",
    options.rpcUrl,
    "--commitment",
    "confirmed",
  ];
  if (info === null) {
    const maxLen = (BigInt(elf.length) * MAX_LEN_FACTOR_NUM) / MAX_LEN_FACTOR_DEN;
    log(`deploying program ${programId.toBase58()} (${elf.length} bytes)`);
    await runSolana(["program", "deploy", soPath, ...common, "--max-len", maxLen.toString()]);
    actions.push("deploy-program");
  } else {
    if (!info.owner.equals(BPF_LOADER_UPGRADEABLE)) {
      throw new Error(`${programId.toBase58()} exists but is not an upgradeable program`);
    }
    const data = await readProgramData(connection, info.data);
    if (data.header.authority === null || !data.header.authority.equals(admin.publicKey)) {
      throw new Error(
        `the program's upgrade authority is ${data.header.authority?.toBase58() ?? "none (immutable)"}, ` +
          `not the admin ${admin.publicKey.toBase58()}; cannot upgrade. Nothing was sent.`,
      );
    }
    if (onChainElfMatches(data.bytes, elf)) {
      log(`program ${programId.toBase58()} is up to date (same ELF, no deploy)`);
    } else if (!options.allowUpgrade) {
      // Anchor builds are not byte-reproducible across machines: never upgrade the live program
      // silently from another worktree.
      throw new Error(
        `the on-chain program differs from this build (on-chain ${sha256Hex(onChainWindow(data.bytes, elf.length))}, ` +
          `built ${soSha(elf)}). Nothing was sent. Pass --allow-upgrade to upgrade it.`,
      );
    } else {
      log(`upgrading program ${programId.toBase58()} (${elf.length} bytes)`);
      await runSolana(["program", "deploy", soPath, ...common]);
      actions.push("upgrade-program");
    }
  }
  if (actions.length > 0) {
    await waitForProgramVisible(connection, programId);
  }
  const after = await connection.getAccountInfo(programId, "confirmed");
  if (after === null) {
    throw new Error(`program ${programId.toBase58()} is missing after the deploy`);
  }
  const final = await readProgramData(connection, after.data);
  if (final.header.authority === null || !final.header.authority.equals(admin.publicKey)) {
    throw new Error(
      `after the deploy the upgrade authority is ${final.header.authority?.toBase58() ?? "none"}, ` +
        `expected the admin ${admin.publicKey.toBase58()}`,
    );
  }
  return final.header.authority;
}

/**
 * A (re)deployed program is invoked from the slot after the deploy lands, and `initialize_config`
 * follows the deploy immediately: wait (bounded, 20 s) until the clock has moved two slots past
 * the deploy so the first Config transaction does not simulate against "Program is not deployed".
 */
async function waitForProgramVisible(connection: Connection, programId: PublicKey): Promise<void> {
  const start = await connection.getSlot("confirmed");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await connection.getSlot("confirmed")) >= start + 2) {
      return;
    }
    await new Promise((resolvePause) => setTimeout(resolvePause, 400));
  }
  throw new Error(`the cluster did not advance after deploying ${programId.toBase58()}`);
}

async function readProgramData(connection: Connection, programAccountData: Uint8Array) {
  const address = programDataAddress(programAccountData);
  if (address === null) {
    throw new Error("the program account is not an upgradeable Program account");
  }
  const info = await connection.getAccountInfo(address, "confirmed");
  const header = info === null ? null : programDataHeader(info.data);
  if (info === null || header === null) {
    throw new Error(`cannot read the ProgramData account ${address.toBase58()}`);
  }
  return { header, bytes: info.data };
}

/** The mint to use: chain truth first (the Config's mint), then `USDC_MINT`, then the record. */
async function ensureMint(
  ctx: Context,
  config: OnChainConfig | null,
  record: DeploymentRecord | null,
): Promise<PublicKey> {
  const { connection, admin, options, log, actions, programId } = ctx;
  const faucet = options.faucet;
  if (config !== null) {
    const mint = config.usdcMint;
    if (options.usdcMintEnv !== undefined && !options.usdcMintEnv.equals(mint)) {
      throw new Error(
        `USDC_MINT is ${options.usdcMintEnv.toBase58()} but the on-chain Config uses ${mint.toBase58()}; nothing was sent`,
      );
    }
    if (!(await verifyMint(connection, mint, faucet))) {
      throw new Error(`the Config's USDC mint ${mint.toBase58()} does not exist on chain`);
    }
    log(`test-USDC mint ${mint.toBase58()} (from the on-chain Config)`);
    return mint;
  }
  const candidate =
    options.usdcMintEnv ?? (record?.usdcMint === undefined ? null : new PublicKey(record.usdcMint));
  if (candidate !== null) {
    if (await verifyMint(connection, candidate, faucet)) {
      log(`test-USDC mint ${candidate.toBase58()} (verified on chain)`);
      return candidate;
    }
    log(`recorded mint ${candidate.toBase58()} does not exist on chain: replacing it`);
  }
  const mint = Keypair.generate();
  // Write-ahead: the pubkey is on disk before the create tx is sent.
  writeRecord(options.outPath, {
    version: 1,
    cluster: ctx.options.solanaCluster === "localnet" ? "localnet" : "devnet",
    programId: programId.toBase58(),
    usdcMint: mint.publicKey.toBase58(),
  });
  await createUsdcMint(connection, admin, mint, faucet);
  actions.push("create-mint");
  log(`created test-USDC mint ${mint.publicKey.toBase58()}`);
  return mint.publicKey;
}

function soSha(elf: Uint8Array): string {
  return sha256Hex(elf);
}

function buildRecord(
  cluster: "devnet" | "localnet",
  ctx: Context,
  mint: PublicKey,
  config: OnChainConfig,
  upgradeAuthority: PublicKey,
): DeploymentRecord {
  const feeds: NonNullable<DeploymentRecord["feeds"]> = {};
  for (const [index, symbol] of TICKER_ORDER.entries()) {
    const slot = config.tickers[index];
    if (slot === undefined) {
      throw new Error(`the Config has no ticker slot ${index}`);
    }
    const pins = [0, 1].map((i) => {
      const pubkey = slot.feeds[i] ?? PublicKey.default;
      const hash = slot.feedHashes[i] ?? new Uint8Array(32);
      return {
        pubkey: pubkey.toBase58(),
        hash: bytesToHex(hash),
        placeholder: isPlaceholderPin({ pubkey, hash }),
      };
    });
    const [first, second] = pins;
    if (first === undefined || second === undefined) {
      throw new Error("unreachable: two feeds per ticker");
    }
    feeds[symbol] = [first, second];
  }
  return {
    version: 1,
    cluster,
    programId: ctx.programId.toBase58(),
    usdcMint: mint.toBase58(),
    configPda: findConfigPda(ctx.programId).address.toBase58(),
    admin: config.admin.toBase58(),
    automationAuthority: config.automationAuthority.toBase58(),
    faucet: ctx.options.faucet.toBase58(),
    upgradeAuthority: upgradeAuthority.toBase58(),
    feeds,
  };
}

/** The devnet build (`anchor build`, default features: no test oracle), run in `repoRoot`. */
export async function buildDevnet(
  repoRoot: string,
  log: (line: string) => void = () => undefined,
): Promise<void> {
  log("building the devnet program (anchor build)");
  await runCommand("anchor", ["build"], { cwd: repoRoot });
}

/**
 * Deploys the devnet build. Order: build, guards (program ID, AB-22 IDL check, cluster, feeds),
 * test-USDC mint, program, Config, record. Idempotent. Every guard runs before the first
 * transaction, and the mint is created before the deploy so that no other transaction sits
 * between the deploy and `initialize_config` (which is first-come).
 */
export async function runDeploy(
  options: Options,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  deps: DeployDeps = {},
): Promise<DeployResult> {
  const safeLog = (line: string) => log(redactRpcUrl(line, options.rpcUrl));
  try {
    return await deploy(options, safeLog, deps.runSolana ?? defaultRunSolana(options));
  } catch (error) {
    // Provider URLs often carry an API key and fetch errors echo them.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactRpcUrl(message, options.rpcUrl));
  }
}

async function deploy(
  options: Options,
  log: (line: string) => void,
  runSolana: RunSolana,
): Promise<DeployResult> {
  if (!options.skipBuild) {
    await buildDevnet(options.repoRoot, log);
  }

  const admin = readKeypairFile(options.adminKeypairPath);
  const programKeypair = readKeypairFile(options.programKeypairPath);
  const programId = programKeypair.publicKey;
  const libRs = readFileSync(
    join(options.repoRoot, "programs", "meridian", "src", "lib.rs"),
    "utf8",
  );
  const idlText = readFileSync(join(options.repoRoot, "target", "idl", "meridian.json"), "utf8");
  assertProgramIds({
    keypair: programId,
    declared: declaredIdFromLibRs(libRs),
    idl: idlAddress(idlText),
    env: options.meridianProgramId,
  });
  assertNoLocalOracle(idlText);
  const soPath = join(options.repoRoot, "target", "deploy", "meridian.so");
  const soSha = sha256Hex(readFileSync(soPath));

  const connection = new Connection(options.rpcUrl, "confirmed");
  const cluster = await assertCluster({
    cluster: options.solanaCluster,
    rpcUrl: options.rpcUrl,
    getGenesisHash: () => connection.getGenesisHash(),
  });
  log(`cluster: ${cluster}`);

  const feeds = options.feedsPath === undefined ? undefined : await loadFeeds(options, connection);

  const ctx: Context = { options, connection, admin, programId, log, actions: [], runSolana };
  const program = createProgram(connection, admin, programId);
  const before = await readOnChainConfig(program);
  if (before !== null) {
    assertConfigAdmin(before, admin.publicKey);
  }
  const record = readRecord(options.outPath);
  const mint = await ensureMint(ctx, before, record);

  const upgradeAuthority = await ensureProgram(ctx, soPath, soSha);

  // Re-read after the deploy: Config may only exist now, and `before` is stale if it did not.
  const current = before ?? (await readOnChainConfig(program));
  if (current !== null) {
    assertConfigAdmin(current, admin.publicKey);
  }
  const steps = planConfig(current, {
    admin: admin.publicKey,
    automationAuthority: options.automation,
    usdcMint: mint,
    feeds,
  });
  for (const step of steps) {
    await sendConfigStep(program, step.kind, step.params, mint, admin.publicKey);
    ctx.actions.push(step.kind);
    log(`${step.kind}: ${step.params.tickers.map((slot) => slot.ticker.symbol).join(", ")}`);
  }
  if (steps.length === 0) {
    log("config is up to date");
  }

  const config = steps.length === 0 ? current : await readOnChainConfig(program);
  if (config === null) {
    throw new Error("the Config is missing after initialize_config");
  }
  assertConfigAdmin(config, admin.publicKey);
  const finalRecord = buildRecord(cluster, ctx, mint, config, upgradeAuthority);
  const written = writeRecord(options.outPath, finalRecord);
  log(`${written ? "wrote" : "unchanged:"} ${options.outPath}`);
  return { actions: ctx.actions, record: finalRecord };
}
