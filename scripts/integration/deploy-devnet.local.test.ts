// M2-01 against a local validator: the whole deploy script, end to end, under a throwaway
// program ID. Never touches devnet (the live run needs OQ-5).
//
// Isolated from the shared tree: the devnet build happens in a temporary copy of the program
// sources with its own cargo target directory, so the tracked files and the shared `target/`
// (the local-oracle build the other suites use) are never modified. Run it serially with
// `make test-deploy-devnet`; it needs `solana-test-validator`, `anchor` and `cargo` on PATH.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnchorError, type Program } from "@coral-xyz/anchor";
import {
  BN,
  configParamsArg,
  configParamsBatches,
  findConfigPda,
  marketAddresses,
  type Meridian,
  symbolBytes,
  tradingDate,
} from "@meridian/client";
import { createMint, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { type Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProgram, readOnChainConfig } from "../lib/chain-io";
import { runDeploy } from "../lib/deploy";
import { bytesToHex, TICKER_ORDER } from "../lib/feeds-file";
import { type Options } from "../lib/options";
import { readRecord } from "../lib/record";
import { FEEDS_FIXTURE_PATH, FIXTURE_QUEUE } from "../test-support/feeds-fixture";
import {
  airdrop,
  buildDevnetInIsolatedCopy,
  makeTempDir,
  newKeypairFile,
  REPO_ROOT,
  removeDir,
  sharedArtifactHashes,
  signatureCount,
  startValidator,
  trackedStatus,
  type Validator,
} from "./harness";

const TRACKED_RECORD = "deployments/devnet.json";
const SB_ACCOUNT_FIXTURE = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "switchboard",
  "pull_feed_meta_tiingo.json",
);
const MINUTE = 60_000;

type Feeds = Record<string, { pubkey: string; hash: string }[]>;
const fixtureFeeds = (): Feeds => JSON.parse(readFileSync(FEEDS_FIXTURE_PATH, "utf8")) as Feeds;
const feedAddresses = (): string[] =>
  Object.values(fixtureFeeds()).flatMap((pair) => pair.map((feed) => feed.pubkey));

const work = makeTempDir("deploy-test");
const logs: string[] = [];
const secretNeedles: string[] = [];

type Actor = { path: string; keypair: Keypair };
let programIdKeypair: Actor;
let programId: PublicKey;
let admin: Actor;
let automation: Actor;
let faucetPubkey: PublicKey;
let statusBefore = "";
let artifactsBefore: Record<string, string | null> = {};
let copyRoot = "";
let trackedRecordBefore = "";

function track(actor: Actor): Actor {
  secretNeedles.push(
    JSON.stringify(Array.from(actor.keypair.secretKey)),
    Array.from(actor.keypair.secretKey).join(","),
    Buffer.from(actor.keypair.secretKey).toString("hex"),
  );
  return actor;
}

function options(rpcUrl: string, overrides: Partial<Options> = {}): Options {
  return {
    repoRoot: copyRoot,
    rpcUrl,
    solanaCluster: "localnet",
    adminKeypairPath: admin.path,
    programKeypairPath: programIdKeypair.path,
    faucet: faucetPubkey,
    automation: automation.keypair.publicKey,
    meridianProgramId: undefined,
    usdcMintEnv: undefined,
    queue: FIXTURE_QUEUE,
    outPath: join(work, "record.json"),
    feedsPath: undefined,
    skipBuild: true,
    ...overrides,
  };
}

const log = (line: string) => logs.push(line);

beforeAll(() => {
  statusBefore = trackedStatus();
  artifactsBefore = sharedArtifactHashes();
  trackedRecordBefore = readFileSync(join(REPO_ROOT, TRACKED_RECORD), "utf8");
  admin = track(newKeypairFile(work, "admin.json"));
  automation = track(newKeypairFile(work, "automation.json"));
  faucetPubkey = newKeypairFile(work, "faucet.json").keypair.publicKey; // only the pubkey is used
  programIdKeypair = { path: join(work, "program.json"), keypair: undefined as unknown as Keypair };
  const built = buildDevnetInIsolatedCopy(join(work, "copy"), programIdKeypair.path);
  copyRoot = built.root;
  programId = built.programId;
  const secret = JSON.parse(readFileSync(programIdKeypair.path, "utf8")) as number[];
  secretNeedles.push(JSON.stringify(secret), secret.join(","));
}, 40 * MINUTE);

afterAll(() => {
  try {
    // The real tree is never modified: tracked files and the shared artifacts are unchanged.
    expect(trackedStatus()).toBe(statusBefore);
    expect(sharedArtifactHashes()).toEqual(artifactsBefore);
  } finally {
    removeDir(work);
  }
}, 5 * MINUTE);

async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message = "";
  try {
    await promise;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(pattern);
}

/** The Anchor error code of a failed transaction. */
function errorCode(error: unknown): string {
  if (error instanceof AnchorError) {
    return error.error.errorCode.code;
  }
  const logsText =
    typeof error === "object" && error !== null && "logs" in error
      ? String(error.logs)
      : String(error);
  return /Error Code: (\w+)/.exec(logsText)?.[1] ?? logsText;
}

describe("AC3 the devnet build has no local_oracle_set (AB-22)", () => {
  it(
    "target/idl/meridian.json from make build-devnet lacks it, checked by ab_22_devnet_build",
    () => {
      // The isolated copy's IDL (absolute: cargo test runs with the package directory as cwd).
      const idlPath = join(copyRoot, "target", "idl", "meridian.json");
      // Fails (does not skip) when the build produced no IDL.
      expect(existsSync(idlPath)).toBe(true);
      const names = (
        JSON.parse(readFileSync(idlPath, "utf8")) as { instructions: { name: string }[] }
      ).instructions.map((i) => i.name);
      expect(names).toContain("settle_market");
      expect(names).not.toContain("local_oracle_set");
      const output = execFileSync(
        "cargo",
        [
          "test",
          "--package",
          "security-tests",
          "--locked",
          "--test",
          "ab_22_devnet_build",
          "devnet_idl_has_no_local_oracle_set",
          "--",
          "--include-ignored",
        ],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, MERIDIAN_DEVNET_IDL: idlPath },
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      // Run for real: the one #[ignore]d test passed; the file's other three were filtered out.
      expect(output).toContain(
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out",
      );
    },
    25 * MINUTE,
  );
});

describe("guards run before any transaction (validator 1)", () => {
  let validator: Validator;
  let other: Actor;
  beforeAll(async () => {
    validator = await startValidator();
    other = track(newKeypairFile(work, "other-admin.json"));
    await airdrop(validator.connection, admin.keypair.publicKey, 200);
    await airdrop(validator.connection, other.keypair.publicKey, 50);
  }, 5 * MINUTE);
  afterAll(async () => validator.stop());

  it("a program keypair that differs from declare_id! fails before any tx", async () => {
    const wrong = newKeypairFile(work, "wrong-program.json");
    const before = await signatureCount(validator.connection, admin.keypair.publicKey);
    await expectRejects(
      runDeploy(options(validator.rpcUrl, { programKeypairPath: wrong.path }), log),
      /declare_id!.*Nothing was sent/s,
    );
    // ...and so does MERIDIAN_PROGRAM_ID naming another program.
    await expectRejects(
      runDeploy(
        options(validator.rpcUrl, { meridianProgramId: wrong.keypair.publicKey.toBase58() }),
        log,
      ),
      /MERIDIAN_PROGRAM_ID/,
    );
    expect(await signatureCount(validator.connection, admin.keypair.publicKey)).toBe(before);
    expect(await validator.connection.getAccountInfo(programId)).toBeNull();
  });

  it("the cluster guard refuses a local validator that is not devnet", async () => {
    const before = await signatureCount(validator.connection, admin.keypair.publicKey);
    await expectRejects(
      runDeploy(options(validator.rpcUrl, { solanaCluster: "devnet" }), log),
      /unknown cluster/,
    );
    expect(await signatureCount(validator.connection, admin.keypair.publicKey)).toBe(before);
    expect(await validator.connection.getAccountInfo(programId)).toBeNull();
  });

  it(
    "a pre-initialised Config owned by another admin fails loudly on every run",
    async () => {
      // Program deployed with the real admin as upgrade authority, Config initialised by `other`.
      execFileSync(
        "solana",
        [
          "program",
          "deploy",
          join(copyRoot, "target", "deploy", "meridian.so"),
          "--program-id",
          programIdKeypair.path,
          "--keypair",
          other.path,
          "--upgrade-authority",
          admin.path,
          "--url",
          validator.rpcUrl,
          "--commitment",
          "confirmed",
        ],
        { cwd: copyRoot, stdio: "ignore" },
      );
      const otherProgram = createProgram(validator.connection, other.keypair, programId);
      const mint = await createMint(
        validator.connection,
        other.keypair,
        other.keypair.publicKey,
        null,
        6,
      );
      const [first] = configParamsBatches(
        {
          automationAuthority: automation.keypair.publicKey,
          maxStalenessSlots: 30n,
          maxConfBps: 5,
          overrideDelaySecs: 3_600n,
        },
        [],
      );
      if (first === undefined) throw new Error("no batch");
      await otherProgram.methods
        .initializeConfig(configParamsArg(first))
        .accountsStrict({
          config: findConfigPda(programId).address,
          admin: other.keypair.publicKey,
          usdcMint: mint,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      const before = await signatureCount(validator.connection, admin.keypair.publicKey);
      for (let run = 0; run < 2; run += 1) {
        await expectRejects(
          runDeploy(options(validator.rpcUrl), log),
          /Config belongs to admin .* not /,
        );
      }
      expect(await signatureCount(validator.connection, admin.keypair.publicKey)).toBe(before);
    },
    5 * MINUTE,
  );
});

describe("deploy, idempotency, feeds and fail-closed settlement (validator 2)", () => {
  let validator: Validator;
  let program: Program<Meridian>;
  const record = join(work, "main-record.json");
  const bogusMint = PublicKey.unique();

  beforeAll(async () => {
    validator = await startValidator(
      feedAddresses().map((address) => ({ address, file: SB_ACCOUNT_FIXTURE })),
    );
    await airdrop(validator.connection, admin.keypair.publicKey, 200);
    await airdrop(validator.connection, automation.keypair.publicKey, 5);
    program = createProgram(validator.connection, admin.keypair, programId);
    // A crash after the write-ahead: the record names a mint that was never created.
    writeFileSync(
      record,
      `${JSON.stringify({ version: 1, cluster: "localnet", programId: programId.toBase58(), usdcMint: bogusMint.toBase58() })}\n`,
    );
  }, 5 * MINUTE);
  afterAll(async () => validator.stop());

  const run = (overrides: Partial<Options> = {}) =>
    runDeploy(options(validator.rpcUrl, { outPath: record, ...overrides }), log);
  const adminSigs = () => signatureCount(validator.connection, admin.keypair.publicKey);

  it(
    "AC1 first run deploys, creates the mint (replacing the absent recorded one) and a 7-slot config",
    async () => {
      const result = await run();
      expect(result.actions).toEqual([
        "deploy-program",
        "create-mint",
        "initialize_config",
        "update_config",
      ]);
      const config = await readOnChainConfig(program);
      if (config === null) throw new Error("no config");
      expect(config.admin.equals(admin.keypair.publicKey)).toBe(true);
      expect(config.automationAuthority.equals(automation.keypair.publicKey)).toBe(true);
      expect(config.tickers.map((t) => t.symbol)).toEqual([...TICKER_ORDER]);
      for (const ticker of config.tickers) {
        expect(ticker.feeds.every((f) => f.equals(PublicKey.default))).toBe(true);
      }
      const mint = await getMint(validator.connection, config.usdcMint);
      expect(mint.decimals).toBe(6);
      expect(mint.mintAuthority?.equals(faucetPubkey)).toBe(true);
      expect(config.usdcMint.equals(bogusMint)).toBe(false);
      expect(result.record.upgradeAuthority).toBe(admin.keypair.publicKey.toBase58());
      expect(readRecord(record)?.usdcMint).toBe(config.usdcMint.toBase58());
      expect(config.maxStalenessSlots).toBe(30n);
      expect(config.maxConfBps).toBe(5);
      expect(config.overrideDelaySecs).toBe(3_600n);
    },
    10 * MINUTE,
  );

  it(
    "AC1 a second run sends nothing and creates no accounts",
    async () => {
      const before = await adminSigs();
      const recordText = readFileSync(record, "utf8");
      const result = await run();
      expect(result.actions).toEqual([]);
      expect(await adminSigs()).toBe(before);
      expect(readFileSync(record, "utf8")).toBe(recordText);
    },
    5 * MINUTE,
  );

  it(
    "AC6 with placeholder feeds, settle_market fails closed",
    async () => {
      const config = await readOnChainConfig(program);
      if (config === null) throw new Error("no config");
      const asAutomation = createProgram(validator.connection, automation.keypair, programId);
      const now = new Date();
      const date = tradingDate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
      const key = { symbol: "META", tradingDate: date, strikeCents: 68_000n };
      const addresses = marketAddresses(key, programId);
      const closeTs = Math.floor(Date.now() / 1000) + 8;
      await asAutomation.methods
        .createStrikeMarket(
          Array.from(symbolBytes("META")),
          new BN("68000"),
          date,
          new BN(String(closeTs)),
        )
        .accountsStrict({
          config: findConfigPda(programId).address,
          automationAuthority: automation.keypair.publicKey,
          market: addresses.market,
          yesMint: addresses.yesMint,
          noMint: addresses.noMint,
          vault: addresses.vault,
          escrowUsdc: addresses.escrowUsdc,
          escrowYes: addresses.escrowYes,
          book: addresses.book,
          usdcMint: config.usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
      // settle_market checks now >= close_ts (NotClosed) before any oracle check.
      while (Date.now() / 1000 < closeTs + 3) {
        await new Promise((r) => setTimeout(r, 500));
      }
      const settle = (tiingo: PublicKey, twelve: PublicKey) =>
        program.methods
          .settleMarket()
          .accountsStrict({
            config: findConfigPda(programId).address,
            market: addresses.market,
            feedTiingo: tiingo,
            feedTwelveData: twelve,
            payer: admin.keypair.publicKey,
          })
          .rpc({ commitment: "confirmed" });
      // The default pubkey (the placeholder's pin) is the system program account: not Switchboard.
      await expect(settle(PublicKey.default, PublicKey.default)).rejects.toSatisfy(
        (e: unknown) => errorCode(e) === "OracleWrongOwner",
      );
      // A Switchboard-owned fixture at an address that is not the pinned (default) key.
      const unpinned = new PublicKey(feedAddresses()[0] ?? "");
      await expect(settle(unpinned, PublicKey.default)).rejects.toSatisfy(
        (e: unknown) => errorCode(e) === "OracleFeedHashMismatch",
      );
      const market = await program.account.market.fetch(addresses.market);
      expect("open" in market.status).toBe(true);
    },
    5 * MINUTE,
  );

  it("AC1 --feeds rejects a hash that differs from oracle/feeds/* before sending anything", async () => {
    const bad = fixtureFeeds();
    const pair = bad.AAPL;
    if (pair?.[0] === undefined) throw new Error("fixture");
    pair[0].hash = "ab".repeat(32);
    const path = join(work, "feeds.bad-hash.json");
    writeFileSync(path, JSON.stringify(bad));
    const before = await adminSigs();
    await expectRejects(run({ feedsPath: path }), /AAPL\.tiingo.*Nothing was sent/s);
    expect(await adminSigs()).toBe(before);
  });

  it("AC1 --feeds rejects a feed account that is not Switchboard-owned before sending anything", async () => {
    const bad = fixtureFeeds();
    const pair = bad.MSFT;
    if (pair?.[1] === undefined) throw new Error("fixture");
    pair[1].pubkey = PublicKey.unique().toBase58();
    const path = join(work, "feeds.bad-owner.json");
    writeFileSync(path, JSON.stringify(bad));
    const before = await adminSigs();
    await expectRejects(run({ feedsPath: path }), /MSFT\.twelvedata.*Nothing was sent/s);
    expect(await adminSigs()).toBe(before);
  });

  it(
    "AC1 --feeds replaces the placeholders in 6 + 1 update_config calls; a rerun sends nothing",
    async () => {
      const result = await run({ feedsPath: FEEDS_FIXTURE_PATH });
      expect(result.actions).toEqual(["update_config", "update_config"]);
      const config = await readOnChainConfig(program);
      if (config === null) throw new Error("no config");
      const fixture = fixtureFeeds();
      for (const [index, symbol] of TICKER_ORDER.entries()) {
        const slot = config.tickers[index];
        const pins = fixture[symbol];
        expect(slot?.symbol).toBe(symbol);
        expect(slot?.feeds.map((f) => f.toBase58())).toEqual(pins?.map((p) => p.pubkey));
        expect(slot?.feedHashes.map((h) => bytesToHex(h))).toEqual(pins?.map((p) => p.hash));
      }
      // scalars were resent from chain, not reset
      expect(config.maxStalenessSlots).toBe(30n);
      const before = await adminSigs();
      const again = await run({ feedsPath: FEEDS_FIXTURE_PATH });
      expect(again.actions).toEqual([]);
      expect(await adminSigs()).toBe(before);
    },
    5 * MINUTE,
  );

  it(
    "AC1 a missing record against a Config holding live feeds leaves those feeds unchanged",
    async () => {
      const config = await readOnChainConfig(program);
      rmSync(record);
      const before = await adminSigs();
      const result = await run();
      expect(result.actions).toEqual([]);
      expect(await adminSigs()).toBe(before);
      const after = await readOnChainConfig(program);
      expect(after?.tickers.map((t) => t.feeds.map((f) => f.toBase58()))).toEqual(
        config?.tickers.map((t) => t.feeds.map((f) => f.toBase58())),
      );
      const rebuilt = readRecord(record);
      expect(rebuilt?.usdcMint).toBe(config?.usdcMint.toBase58());
      expect(rebuilt?.feeds?.AAPL?.[0].placeholder).toBe(false);
    },
    5 * MINUTE,
  );

  it(
    "AC1 a stale record never causes a second mint: the Config's mint wins",
    async () => {
      const config = await readOnChainConfig(program);
      writeFileSync(
        record,
        `${JSON.stringify({ version: 1, cluster: "localnet", programId: programId.toBase58(), usdcMint: PublicKey.unique().toBase58() })}\n`,
      );
      const before = await adminSigs();
      const result = await run();
      expect(result.actions).toEqual([]);
      expect(await adminSigs()).toBe(before);
      expect(readRecord(record)?.usdcMint).toBe(config?.usdcMint.toBase58());
      // A USDC_MINT that disagrees with the Config is refused too.
      await expectRejects(
        run({ usdcMintEnv: PublicKey.unique() }),
        /USDC_MINT is .* but the on-chain Config uses/,
      );
      expect(await adminSigs()).toBe(before);
    },
    5 * MINUTE,
  );

  it(
    "the CLI refuses a devnet claim on this validator (exit 1, genesis hash mismatch)",
    () => {
      let output = "";
      let code = 0;
      try {
        execFileSync(process.execPath, ["--import", "tsx", "deploy-devnet.ts", "--skip-build"], {
          cwd: join(REPO_ROOT, "scripts"),
          env: {
            ...process.env,
            SOLANA_RPC_URL: validator.rpcUrl,
            SOLANA_CLUSTER: "devnet",
            ADMIN_KEYPAIR_PATH: admin.path,
            PROGRAM_KEYPAIR_PATH: programIdKeypair.path,
            FAUCET_PUBKEY: faucetPubkey.toBase58(),
            AUTOMATION_PUBKEY: automation.keypair.publicKey.toBase58(),
          },
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        code = failure.status ?? -1;
        output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      }
      logs.push(output);
      expect(code).toBe(1);
      expect(output).toMatch(/unknown cluster/);
    },
    5 * MINUTE,
  );
});

describe("AC4 no secrets and no changes to tracked files", () => {
  it("logs and records never contain key material", () => {
    const text = logs.join("\n");
    for (const needle of secretNeedles) {
      expect(text).not.toContain(needle);
    }
    const recordText = readFileSync(join(work, "record.json"), { encoding: "utf8", flag: "a+" });
    for (const needle of secretNeedles) {
      expect(recordText).not.toContain(needle);
    }
  });

  it("the tracked deployments/devnet.json was not touched by the tests", () => {
    expect(readFileSync(join(REPO_ROOT, TRACKED_RECORD), "utf8")).toBe(trackedRecordBefore);
  });
});
