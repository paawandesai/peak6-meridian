/**
 * Production wiring of the settlement path for one cluster and one payer; shared by the service
 * (`main.ts`, payer = the loaded automation key) and the `settle-now` CLI (payer = any funded
 * keypair). Not unit-tested (thin glue over tested parts); the local-validator run in
 * `tests/e2e` exercises the localnet branch.
 */
import { readFileSync } from "node:fs";

import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { createMeridianProgram, findConfigPda } from "@meridian/client";
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import type { SwitchboardClient } from "switchboard-scripts/devnet";
import { z } from "zod";

import { createAlerter } from "./alerts";
import type { ClusterName } from "./cluster";
import type { PythSettlementEnv } from "./config";
import { createIncidentClient } from "./incidents";
import { consoleLogger } from "./log";
import { fetchPrevClose, type HttpGet } from "./prevCloses";
import { connectionExecutor } from "./executor";
import { fetchSignedPrice, type HttpPost } from "./pythLazer";
import {
  buildPythSettleInstructions,
  createPythSettler,
  readPythConfig,
  type PythSettler,
} from "./pythSettle";
import { programSettleChain } from "./settleChain";
import type { CommonRuntime } from "./settleRuntime";
import { buildSettleInstructions } from "./settleTx";
import {
  localOracleAdapter,
  selectAdapter,
  sdkFeedUpdater,
  switchboardAdapter,
} from "./switchboard";

const httpGet: HttpGet = (url, init) =>
  fetch(url, { headers: { ...init.headers }, signal: init.signal });
const httpPost: HttpPost = (url, init) =>
  fetch(url, { method: "POST", headers: init.headers, body: init.body, signal: init.signal });

/** A keypair file (JSON array of 64 bytes). Errors never include the path or the content. */
export function readKeypairFile(path: string): Keypair {
  const bytes = z
    .array(z.number().int().min(0).max(255))
    .length(64)
    .parse(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export interface RuntimeEnv {
  readonly rpcUrl: string;
  readonly programId: PublicKey;
  readonly tiingoApiKey: string;
  readonly twelveDataApiKey: string;
  readonly alertWebhookUrl?: string | undefined;
  readonly opsAgentUrl?: string | undefined;
  readonly serviceToken?: string | undefined;
  /** Local validator only: the Config admin that signs `local_oracle_set`. */
  readonly adminKeypair?: Keypair | undefined;
  /** Pyth settlement (D-055); null or absent keeps the default oracle-update path. */
  readonly pyth?: PythSettlementEnv | null | undefined;
}

export function buildRuntime(
  env: RuntimeEnv,
  cluster: ClusterName,
  payer: Keypair,
): CommonRuntime & { readonly program: ReturnType<typeof createMeridianProgram> } {
  const log = consoleLogger;
  const connection = new Connection(env.rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = createMeridianProgram(provider, env.programId);
  const config = findConfigPda(env.programId).address;
  const post = (url: string, init: RequestInit): Promise<{ status: number }> =>
    fetch(url, { method: "POST", ...init });

  const adapter = selectAdapter({
    cluster,
    local: () => {
      if (env.adminKeypair === undefined) {
        throw new Error("the local oracle needs the Config admin keypair (ADMIN_KEYPAIR_PATH)");
      }
      return localOracleAdapter({ program, config, admin: env.adminKeypair });
    },
    switchboard: () => {
      // The on-demand SDK client (from scripts/switchboard, M1-09) is built once, on first use,
      // and only when a devnet settlement needs it.
      let client: Promise<SwitchboardClient> | undefined;
      const sdk = (): Promise<SwitchboardClient> => {
        client ??= import("switchboard-scripts/devnet").then((m) => m.sdkClient(connection, payer));
        return client;
      };
      return switchboardAdapter(
        sdkFeedUpdater({
          client: sdk,
          overrides: { TIINGO_API_KEY: env.tiingoApiKey, TWELVEDATA_API_KEY: env.twelveDataApiKey },
        }),
      );
    },
  });

  const executor = connectionExecutor(connection, payer);
  const pythEnv = env.pyth;
  const pyth: PythSettler | undefined =
    pythEnv === null || pythEnv === undefined
      ? undefined
      : createPythSettler({
          readConfig: () => readPythConfig(program, config),
          fetchSigned: (feedId, timestampUs) =>
            fetchSignedPrice({
              post: httpPost,
              token: pythEnv.apiToken,
              baseUrl: pythEnv.baseUrl,
              feedId,
              timestampUs,
            }),
          buildSettleIxs: (markets, feeds) =>
            buildPythSettleInstructions({
              program,
              config,
              payer: payer.publicKey,
              markets: markets.map((m) => m.address),
              feeds,
            }),
          payer: payer.publicKey,
          executor,
          now: () => new Date(),
        });

  return {
    program,
    chain: programSettleChain(program, config, payer.publicKey),
    verifyClose: (ticker, date) =>
      fetchPrevClose(
        { http: httpGet, tiingoApiKey: env.tiingoApiKey, twelveDataApiKey: env.twelveDataApiKey },
        ticker,
        date,
      ),
    adapter,
    buildSettleIxs: (markets, feeds) =>
      buildSettleInstructions({
        program,
        config,
        payer: payer.publicKey,
        markets: markets.map((m) => m.address),
        feeds,
      }),
    executor,
    pyth,
    alerter: createAlerter({ webhookUrl: env.alertWebhookUrl, post, log }),
    incidents: createIncidentClient({
      url: env.opsAgentUrl,
      token: env.serviceToken,
      post,
      log,
    }),
    log,
  };
}
