/**
 * `pnpm --filter automation settle-now --payer <keypair path> [--date YYYY-MM-DD]`
 * Settles every open, closed market with any funded keypair (see `settleNow.ts`). Environment:
 * SOLANA_CLUSTER (localnet|devnet), SOLANA_RPC_URL, MERIDIAN_PROGRAM_ID, TIINGO_API_KEY,
 * TWELVEDATA_API_KEY; on localnet also ADMIN_KEYPAIR_PATH (the Config admin, signs the test-only
 * local oracle). The keypair path is never printed.
 */
import { MERIDIAN_PROGRAM_ID } from "@meridian/client";
import { Connection, PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { assertCluster } from "./cluster";
import { buildRuntime, readKeypairFile } from "./runtime";
import { settleNow } from "./settleNow";

const env = z
  .object({
    SOLANA_CLUSTER: z.string().min(1),
    SOLANA_RPC_URL: z.url(),
    MERIDIAN_PROGRAM_ID: z.string().optional(),
    TIINGO_API_KEY: z.string().min(1),
    TWELVEDATA_API_KEY: z.string().min(1),
    ADMIN_KEYPAIR_PATH: z.string().optional(),
    ALERT_WEBHOOK_URL: z.string().optional(),
  })
  .parse({
    ...process.env,
    SOLANA_RPC_URL: process.env.MERIDIAN_DEVNET_RPC_URL?.trim() || process.env.SOLANA_RPC_URL,
  });

settleNow({
  argv: process.argv.slice(2),
  cluster: env.SOLANA_CLUSTER,
  rpcUrl: env.SOLANA_RPC_URL,
  assertCluster,
  getGenesisHash: () => new Connection(env.SOLANA_RPC_URL).getGenesisHash(),
  loadKeypair: readKeypairFile,
  runtime: async ({ cluster, payer }) =>
    buildRuntime(
      {
        rpcUrl: env.SOLANA_RPC_URL,
        programId:
          env.MERIDIAN_PROGRAM_ID === undefined || env.MERIDIAN_PROGRAM_ID === ""
            ? MERIDIAN_PROGRAM_ID
            : new PublicKey(env.MERIDIAN_PROGRAM_ID),
        tiingoApiKey: env.TIINGO_API_KEY,
        twelveDataApiKey: env.TWELVEDATA_API_KEY,
        alertWebhookUrl: env.ALERT_WEBHOOK_URL,
        adminKeypair:
          cluster === "localnet" && env.ADMIN_KEYPAIR_PATH !== undefined
            ? readKeypairFile(env.ADMIN_KEYPAIR_PATH)
            : undefined,
      },
      cluster,
      payer,
    ),
  now: () => new Date(),
  out: (line) => console.log(line),
})
  .then((result) => {
    process.exit(result.failed === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    // Messages are built never to contain the RPC URL, the key path or any key material.
    console.error(error instanceof Error ? error.message : "settle-now failed");
    process.exit(1);
  });
