/**
 * Entry point of the automation service: `pnpm --filter automation start`.
 * Configuration comes from the environment (docs/environment.md); nothing secret is logged.
 */
import { AnchorProvider } from "@coral-xyz/anchor";
import { MERIDIAN_PROGRAM_ID, createMeridianProgram, findConfigPda } from "@meridian/client";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";

import { createAlerter } from "./alerts";
import { chainMarketOps } from "./cli/createMarkets";
import { assertCluster } from "./cluster";
import { loadAutomationKey, parseEnv } from "./config";
import { checkBalance, createSettlementJob, JOB_OPTIONS, SettleMemory } from "./jobs/settle";
import { consoleLogger, describeError } from "./log";
import { connectionOpenTimeRpc, createOpenTimeIndex } from "./openTimes";
import { buildRuntime, readKeypairFile } from "./runtime";
import { defaultCron } from "./scheduler";
import { startService } from "./service";
import { RunState } from "./state";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const log = consoleLogger;
  // Refuse to run against anything but localnet or devnet, decided before any key is used.
  const cluster = await assertCluster({
    cluster: env.SOLANA_CLUSTER,
    rpcUrl: env.SOLANA_RPC_URL,
    getGenesisHash: () => new Connection(env.SOLANA_RPC_URL).getGenesisHash(),
  });
  // A missing or unparseable key starts the service degraded instead of crashing it (AC5b).
  const { keypair } = loadAutomationKey(env.AUTOMATION_KEYPAIR, log);
  const programId =
    env.MERIDIAN_PROGRAM_ID === undefined
      ? MERIDIAN_PROGRAM_ID
      : new PublicKey(env.MERIDIAN_PROGRAM_ID);
  const alerter = createAlerter({
    webhookUrl: env.ALERT_WEBHOOK_URL,
    log,
    post: (url, init) => fetch(url, { method: "POST", ...init }),
  });
  const state = new RunState();
  const memory = new SettleMemory();
  // The open-time index (P1-4) reads the chain only, so it needs no signer and runs in every
  // degraded mode; it learns the automation authority from Config.
  const readConnection = new Connection(env.SOLANA_RPC_URL, "confirmed");
  const readOnly = createMeridianProgram(
    new AnchorProvider(
      readConnection,
      {
        publicKey: PublicKey.default,
        signTransaction: () => Promise.reject(new Error("read-only")),
        signAllTransactions: () => Promise.reject(new Error("read-only")),
      },
      { commitment: "confirmed" },
    ),
    programId,
  );
  const openTimes = createOpenTimeIndex({
    rpc: connectionOpenTimeRpc(readConnection),
    programId,
    readAuthority: async () =>
      (await readOnly.account.config.fetch(findConfigPda(programId).address)).automationAuthority,
    now: () => new Date(),
    log,
  });

  const service = await startService({
    serviceToken: env.SERVICE_TOKEN,
    port: env.PORT,
    signer: keypair,
    state,
    withSigner: async (signer) => {
      const runtime = buildRuntime(
        {
          rpcUrl: env.SOLANA_RPC_URL,
          programId,
          tiingoApiKey: env.TIINGO_API_KEY,
          twelveDataApiKey: env.TWELVEDATA_API_KEY,
          alertWebhookUrl: env.ALERT_WEBHOOK_URL,
          opsAgentUrl: env.OPS_AGENT_URL,
          serviceToken: env.SERVICE_TOKEN,
          adminKeypair:
            cluster === "localnet" && env.ADMIN_KEYPAIR_PATH !== undefined
              ? readKeypairFile(env.ADMIN_KEYPAIR_PATH)
              : undefined,
        },
        cluster,
        signer,
      );
      const now = (): Date => new Date();
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      return {
        readAutomationAuthority: async () =>
          (await runtime.program.account.config.fetch(findConfigPda(programId).address))
            .automationAuthority,
        morning: {
          now,
          sleep,
          prevClose: runtime.verifyClose,
          marketOps: await chainMarketOps(
            runtime.program,
            TOKEN_PROGRAM_ID,
            SystemProgram.programId,
          ),
          demoMode: env.DEMO_MODE,
          demoCloseInSecs: env.DEMO_CLOSE_IN_SECS,
          cluster,
        },
        // Settlement is permissionless: the loaded key is only the fee payer here (AB-19).
        settlement: createSettlementJob({
          now,
          sleep,
          chain: runtime.chain,
          verifyClose: runtime.verifyClose,
          adapter: runtime.adapter,
          buildSettleIxs: runtime.buildSettleIxs,
          payer: signer.publicKey,
          executor: runtime.executor,
          alerter,
          incidents: runtime.incidents,
          state,
          log,
          options: JOB_OPTIONS,
          memory,
        }),
        // The payer must be funded before the first settlement is due (ticket: checked at startup).
        startupCheck: () =>
          checkBalance({ chain: runtime.chain, alerter, options: JOB_OPTIONS }, memory),
      };
    },
    cron: defaultCron,
    alerter,
    log,
    openTimes,
  });

  const shutdown = (signal: string): void => {
    log("info", "shutdown", { signal });
    void service.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  consoleLogger("error", "startup_failed", { error: describeError(error) });
  process.exit(1);
});
