import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertCluster, findConfigPda } from "@meridian/client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { computeFeedHash, loadFeedDefinitions } from "switchboard-scripts";

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
import { isSwitchboardOwner } from "./switchboard";
import {
  BPF_LOADER_UPGRADEABLE,
  onChainElfMatches,
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
};

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
  return feeds;
}

async function ensureProgram(ctx: Context, soPath: string): Promise<PublicKey> {
  const { connection, admin, programId, options, log, actions } = ctx;
  const elf = readFileSync(soPath);
  const info = await connection.getAccountInfo(programId, "confirmed");
  const common = [
    "--program-id",
    options.programKeypairPath,
    "--keypair",
    options.adminKeypairPath,
    "--upgrade-authority",
    options.adminKeypairPath,
    "--url",
    options.rpcUrl,
    "--commitment",
    "confirmed",
  ];
  if (info === null) {
    const maxLen = (BigInt(elf.length) * MAX_LEN_FACTOR_NUM) / MAX_LEN_FACTOR_DEN;
    log(`deploying program ${programId.toBase58()} (${elf.length} bytes)`);
    await runCommand(
      "solana",
      ["program", "deploy", soPath, ...common, "--max-len", maxLen.toString()],
      { cwd: options.repoRoot },
    );
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
      log(`program ${programId.toBase58()} is up to date`);
    } else {
      log(`upgrading program ${programId.toBase58()} (${elf.length} bytes)`);
      await runCommand("solana", ["program", "deploy", soPath, ...common], {
        cwd: options.repoRoot,
      });
      actions.push("upgrade-program");
    }
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

/**
 * Deploys the devnet build: guards, program (deploy or upgrade), test-USDC mint, Config.
 * Idempotent; every guard runs before the first transaction.
 */
export async function runDeploy(
  options: Options,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<DeployResult> {
  const connection = new Connection(options.rpcUrl, "confirmed");
  const cluster = await assertCluster({
    connection,
    rpcUrl: options.rpcUrl,
    solanaCluster: options.solanaCluster,
  });
  log(`cluster: ${cluster}`);

  const admin = readKeypairFile(options.adminKeypairPath);
  const programKeypair = readKeypairFile(options.programKeypairPath);
  const programId = programKeypair.publicKey;
  const libRs = readFileSync(
    join(options.repoRoot, "programs", "meridian", "src", "lib.rs"),
    "utf8",
  );
  assertProgramIds({
    keypair: programId,
    declared: declaredIdFromLibRs(libRs),
    env: options.meridianProgramId,
  });

  const feeds = options.feedsPath === undefined ? undefined : await loadFeeds(options, connection);

  if (!options.skipBuild) {
    log("building the devnet program (make build-devnet)");
    await runCommand("make", ["build-devnet"], { cwd: options.repoRoot });
  }
  const idlPath = join(options.repoRoot, "target", "idl", "meridian.json");
  assertProgramIds({
    keypair: programId,
    declared: declaredIdFromLibRs(libRs),
    idl: idlAddress(readFileSync(idlPath, "utf8")),
    env: options.meridianProgramId,
  });

  const ctx: Context = { options, connection, admin, programId, log, actions: [] };
  const upgradeAuthority = await ensureProgram(
    ctx,
    join(options.repoRoot, "target", "deploy", "meridian.so"),
  );

  const program = createProgram(connection, admin, programId);
  const before = await readOnChainConfig(program);
  if (before !== null) {
    assertConfigAdmin(before, admin.publicKey);
  }
  const record = readRecord(options.outPath);
  const mint = await ensureMint(ctx, before, record);

  const steps = planConfig(before, {
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

  const config = steps.length === 0 ? before : await readOnChainConfig(program);
  if (config === null) {
    throw new Error("the Config is missing after initialize_config");
  }
  assertConfigAdmin(config, admin.publicKey);
  const finalRecord = buildRecord(cluster, ctx, mint, config, upgradeAuthority);
  const written = writeRecord(options.outPath, finalRecord);
  log(`${written ? "wrote" : "unchanged:"} ${options.outPath}`);
  return { actions: ctx.actions, record: finalRecord };
}
