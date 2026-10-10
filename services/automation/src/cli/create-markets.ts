/**
 * `create-markets`: the morning CLI (FR-13). Reads previous closes from a file, computes the
 * day's strikes and creates the missing markets on any cluster; safe to run repeatedly.
 *
 *   tsx src/cli/create-markets.ts --prev-closes tests/fixtures/prev_closes.json \
 *     [--date YYYY-MM-DD] [--close-in-secs N] [--allow-test-close] [--program-id <pubkey>]
 *
 * Environment: ANCHOR_PROVIDER_URL (RPC), ANCHOR_WALLET (the automation authority's keypair
 * file), and SOLANA_CLUSTER (localnet|devnet). Nothing secret is printed.
 *
 * P0-1 guard: `--close-in-secs` on devnet without `--allow-test-close` exits non-zero. Real
 * markets only on the shared devnet deployment; test markets use a local validator.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  assertCluster,
  createMeridianProgram,
  isLoopbackUrl,
  MERIDIAN_PROGRAM_ID,
} from "@meridian/client";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { z } from "zod";

import {
  chainMarketOps,
  checkTestMarketGuard,
  createMarkets,
  isoDateSchema,
  planMarkets,
  prevClosesFileSchema,
} from "./createMarkets";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const envSchema = z.object({
  ANCHOR_PROVIDER_URL: z.string().url(),
  ANCHOR_WALLET: z.string().min(1),
  SOLANA_CLUSTER: z.string().optional(), // "localnet" | "devnet" | undefined
});

function loadKeypair(path: string): Keypair {
  const bytes = z
    .array(z.number().int().min(0).max(255))
    .parse(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  const { values } = parseArgs({
    options: {
      "prev-closes": { type: "string" },
      date: { type: "string" },
      "close-in-secs": { type: "string" },
      "allow-test-close": { type: "boolean" },
      "program-id": { type: "string" },
    },
  });
  const file = prevClosesFileSchema.parse(
    JSON.parse(readFileSync(z.string().min(1).parse(values["prev-closes"]), "utf8")),
  );
  const tradingDate = isoDateSchema.parse(values.date ?? file.tradingDate);

  const connection = new Connection(env.ANCHOR_PROVIDER_URL, "confirmed");

  // P0-1: refuse test markets (--close-in-secs) on the shared devnet deployment unless
  // --allow-test-close is explicitly passed. Resolve the cluster via genesis hash (fail-closed),
  // not the SOLANA_CLUSTER string. e2e and rehearsals use their own local validator.
  // Treat loopback URLs as localnet when SOLANA_CLUSTER is unset (make e2e, make dev).
  const cluster =
    env.SOLANA_CLUSTER === undefined && isLoopbackUrl(env.ANCHOR_PROVIDER_URL)
      ? "localnet"
      : env.SOLANA_CLUSTER;
  const resolvedCluster = await assertCluster({
    cluster,
    rpcUrl: env.ANCHOR_PROVIDER_URL,
    getGenesisHash: () => connection.getGenesisHash(),
  });
  checkTestMarketGuard({
    hasCloseInSecs: values["close-in-secs"] !== undefined,
    allowTestClose: values["allow-test-close"] === true,
    resolvedCluster,
  });
  const provider = new AnchorProvider(connection, new Wallet(loadKeypair(env.ANCHOR_WALLET)), {
    commitment: "confirmed",
  });
  const programId =
    values["program-id"] === undefined ? MERIDIAN_PROGRAM_ID : new PublicKey(values["program-id"]);
  const program = createMeridianProgram(provider, programId);

  const closeIn = values["close-in-secs"];
  const closeTs =
    closeIn === undefined
      ? undefined
      : Math.floor(Date.now() / 1000) + z.coerce.number().int().positive().parse(closeIn);
  const plan = planMarkets({
    tradingDate,
    closes: file.closes,
    ...(closeTs === undefined ? {} : { closeTs }),
  });
  const ops = await chainMarketOps(program, TOKEN_PROGRAM_ID, SystemProgram.programId);
  const report = await createMarkets(plan, ops, (planned, signature) => {
    console.log(`created ${planned.key.symbol} ${planned.key.strikeCents} ${signature}`);
  });
  console.log(
    `create-markets ${tradingDate}: ${report.created.length} created, ${report.skipped.length} already existed`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
