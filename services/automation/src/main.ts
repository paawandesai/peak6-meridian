/**
 * Entry point of the automation service: `pnpm --filter automation start`.
 * Configuration comes from the environment (docs/environment.md); nothing secret is logged.
 */
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { createMeridianProgram, findConfigPda, MERIDIAN_PROGRAM_ID } from "@meridian/client";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";

import { createAlerter } from "./alerts";
import { chainMarketOps } from "./cli/createMarkets";
import { loadAutomationKey, parseEnv } from "./config";
import { placeholderSettlementJob } from "./jobs/settle";
import { consoleLogger, describeError } from "./log";
import { fetchPrevClose, type HttpGet } from "./prevCloses";
import { defaultCron } from "./scheduler";
import { startService } from "./service";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const httpGet: HttpGet = (url, init) =>
  fetch(url, { headers: { ...init.headers }, signal: init.signal });

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const log = consoleLogger;
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

  const service = await startService({
    serviceToken: env.SERVICE_TOKEN,
    port: env.PORT,
    signer: keypair,
    withSigner: async (signer) => {
      const provider = new AnchorProvider(
        new Connection(env.SOLANA_RPC_URL, "confirmed"),
        new Wallet(signer),
        { commitment: "confirmed" },
      );
      const program = createMeridianProgram(provider, programId);
      return {
        readAutomationAuthority: async () =>
          (await program.account.config.fetch(findConfigPda(programId).address))
            .automationAuthority,
        morning: {
          now: () => new Date(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          prevClose: (ticker, date) =>
            fetchPrevClose(
              {
                http: httpGet,
                tiingoApiKey: env.TIINGO_API_KEY,
                twelveDataApiKey: env.TWELVEDATA_API_KEY,
              },
              ticker,
              date,
            ),
          marketOps: await chainMarketOps(program, TOKEN_PROGRAM_ID, SystemProgram.programId),
        },
        settlement: placeholderSettlementJob(signer),
      };
    },
    cron: defaultCron,
    alerter,
    log,
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
