// Config migration (M3-10b): grows the v1 Config to the current layout with `migrate_config`,
// then verifies it. Entry point: `make migrate-config` (see MIGRATE_USAGE). Devnet/localnet only.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCluster,
  findConfigPda,
  MERIDIAN_PROGRAM_ID,
  pythConfigArg,
  redactRpcUrl,
} from "@meridian/client";
import { Connection, SystemProgram } from "@solana/web3.js";

import { createProgram } from "./lib/chain-io";
import { readKeypairFile } from "./lib/keypair";
import {
  classifyConfigAccount,
  CONFIG_V2_LEN,
  decodeConfigPrefix,
  MIGRATE_USAGE,
  type MigrateOptions,
  parseMigrateOptions,
  rentTopUp,
  verifyMigrated,
} from "./lib/migrate-config";

const log = (line: string): void => {
  process.stdout.write(`migrate-config: ${line}\n`);
};

/** Base fee of one signature, for the balance check. */
const FEE_LAMPORTS = 5_000;

type Decoded = {
  pythLazerSigner: { toBase58(): string };
  pythFeedIds: number[];
  pythMaxAgeSecs: { toString(): string };
};

function describePrefix(data: Uint8Array): string {
  const p = decodeConfigPrefix(data);
  return [
    `admin=${p.admin.toBase58()}`,
    `automation=${p.automationAuthority.toBase58()}`,
    `usdc_mint=${p.usdcMint.toBase58()}`,
    `paused=${p.paused}`,
    `max_staleness_slots=${p.maxStalenessSlots}`,
    `max_conf_bps=${p.maxConfBps}`,
    `override_delay_secs=${p.overrideDelaySecs}`,
    `bump=${p.bump}`,
  ].join(" ");
}

async function run(options: MigrateOptions): Promise<void> {
  const connection = new Connection(options.rpcUrl, "confirmed");
  const cluster = await assertCluster({
    cluster: options.solanaCluster,
    rpcUrl: options.rpcUrl,
    getGenesisHash: () => connection.getGenesisHash(),
  });
  const programId = options.programId ?? MERIDIAN_PROGRAM_ID;
  const admin = readKeypairFile(options.adminKeypairPath);
  const program = createProgram(connection, admin, programId);
  const config = findConfigPda(programId).address;
  log(`cluster=${cluster} program=${programId.toBase58()} config=${config.toBase58()}`);
  log(`signer=${admin.publicKey.toBase58()} dry_run=${options.dryRun}`);

  const account = await connection.getAccountInfo(config, "confirmed");
  if (account === null) {
    throw new Error(`no Config account at ${config.toBase58()}`);
  }
  const before = Uint8Array.from(account.data);
  const state = classifyConfigAccount(before, account.owner, programId);
  log(`before: size=${before.length} lamports=${account.lamports} layout=${state}`);
  log(`before: ${describePrefix(before)}`);
  const rentExempt = await connection.getMinimumBalanceForRentExemption(CONFIG_V2_LEN);

  if (state === "v2") {
    const decoded = program.coder.accounts.decode<Decoded>("config", account.data);
    log(
      `already migrated: pyth_lazer_signer=${decoded.pythLazerSigner.toBase58()} ` +
        `pyth_feed_ids=${decoded.pythFeedIds.join(",")} pyth_max_age_secs=${decoded.pythMaxAgeSecs.toString()}`,
    );
    log("nothing to do (migrate_config would fail with ConfigAlreadyMigrated)");
    return;
  }

  const prefix = decodeConfigPrefix(before);
  if (!prefix.admin.equals(admin.publicKey)) {
    throw new Error(
      `the Config admin is ${prefix.admin.toBase58()}, not the signer ${admin.publicKey.toBase58()}; nothing was sent`,
    );
  }
  const topUp = rentTopUp(rentExempt, account.lamports);
  const balance = await connection.getBalance(admin.publicKey, "confirmed");
  log(`rent: exempt(${CONFIG_V2_LEN})=${rentExempt} top_up=${topUp} admin_balance=${balance}`);
  if (balance < topUp + FEE_LAMPORTS) {
    throw new Error(`admin balance ${balance} is below top-up + fee ${topUp + FEE_LAMPORTS}`);
  }
  log(
    options.pyth === null
      ? "pyth: none (fields zero-filled; set them later with update_config)"
      : `pyth: signer=${options.pyth.lazerSigner.toBase58()} feed_ids=${options.pyth.feedIds.join(",")} max_age_secs=${options.pyth.maxAgeSecs}`,
  );

  const method = program.methods
    .migrateConfig(options.pyth === null ? null : pythConfigArg(options.pyth))
    .accountsStrict({ config, admin: admin.publicKey, systemProgram: SystemProgram.programId });

  if (options.dryRun) {
    const tx = await method.transaction();
    tx.feePayer = admin.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const simulation = await connection.simulateTransaction(tx, [admin]);
    for (const line of simulation.value.logs ?? []) log(`  sim: ${line}`);
    if (simulation.value.err !== null) {
      throw new Error(`simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    log("DRY_RUN: simulation succeeded; nothing was sent");
    return;
  }

  const signature = await method.rpc({ commitment: "confirmed" });
  log(`sent migrate_config: ${signature}`);

  const migrated = await connection.getAccountInfo(config, "confirmed");
  if (migrated === null) {
    throw new Error("the Config account disappeared after migration");
  }
  const after = Uint8Array.from(migrated.data);
  const problems = verifyMigrated({
    before,
    after,
    pyth: options.pyth,
    lamports: migrated.lamports,
    rentExemptLamports: rentExempt,
  });
  const decoded = program.coder.accounts.decode<Decoded>("config", migrated.data);
  if (describePrefix(after) !== describePrefix(before)) {
    problems.push("the decoded v1 fields differ after migration");
  }
  if (problems.length > 0) {
    throw new Error(`verification FAILED: ${problems.join("; ")}`);
  }
  log(`after: size=${after.length} lamports=${migrated.lamports} layout=v2`);
  log(`after: ${describePrefix(after)}`);
  log(
    `after: pyth_lazer_signer=${decoded.pythLazerSigner.toBase58()} ` +
      `pyth_feed_ids=${decoded.pythFeedIds.join(",")} pyth_max_age_secs=${decoded.pythMaxAgeSecs.toString()}`,
  );
  log(`verified: bytes 0..${before.length} unchanged byte-for-byte; new fields as expected`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(MIGRATE_USAGE);
    return;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  await run(parseMigrateOptions(process.env, repoRoot));
}

main().catch((error: unknown) => {
  // The message only: errors never carry key material (lib/keypair.ts); RPC URLs are redacted.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `migrate-config: ${redactRpcUrl(message, process.env.SOLANA_RPC_URL ?? "")}\n`,
  );
  process.exitCode = 1;
});
