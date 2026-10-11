/**
 * `settle-now` (M2-04 AC7): settle every open, closed market by hand with ANY funded keypair.
 * Fallback for when the automation key is unavailable: `settle_market` is permissionless, so the
 * payer only pays fees. It runs the same path as the job (off-chain date verification, oracle
 * update, `settle_market`, settled markets skipped) once, without the 5-minute delay, and it
 * refuses any cluster that `assertCluster` does not accept (localnet or devnet only). The
 * keypair path is never logged or echoed and the file's contents are never read into output.
 *
 * The job's pacing applies (#53): groups whose session has not completed (weekends, holidays,
 * sessions still running) are skipped without any data-API request (settle those by admin
 * override), and one invocation makes at most `maxApiCallsPerRun` data-API requests; groups that
 * do not fit, or that a rate limit deferred, are listed so the operator runs it again a minute
 * later.
 */
import { type Keypair } from "@solana/web3.js";
import { z } from "zod";

import { type AlerterLike, type CommonRuntime } from "./settleRuntime";
import { isoDateSchema } from "./cli/createMarkets";
import type { AssertCluster, ClusterName } from "./cluster";
import { JOB_OPTIONS, runSettlement } from "./jobs/settle";
import { RunState } from "./state";

const argsSchema = z.object({ payer: z.string().min(1), date: isoDateSchema.optional() });
export type SettleNowArgs = z.infer<typeof argsSchema>;

/** `--payer <keypair path> [--date YYYY-MM-DD]`. Errors never echo the values. */
export function parseSettleNowArgs(argv: readonly string[]): SettleNowArgs {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      (flag !== "--payer" && flag !== "--date") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("usage: settle-now --payer <keypair path> [--date YYYY-MM-DD]");
    }
    values[flag.slice(2)] = value;
  }
  const parsed = argsSchema.safeParse(values);
  if (!parsed.success) {
    throw new Error(
      "usage: settle-now --payer <keypair path> [--date YYYY-MM-DD] (--date must be a real ISO date)",
    );
  }
  return parsed.data;
}

export interface SettleNowParams {
  readonly argv: readonly string[];
  readonly cluster: string;
  readonly rpcUrl: string;
  readonly assertCluster: AssertCluster;
  readonly getGenesisHash: () => Promise<string>;
  readonly loadKeypair: (path: string) => Keypair;
  /** Builds the cluster-specific pieces once the cluster is verified and the payer is loaded. */
  readonly runtime: (ctx: { cluster: ClusterName; payer: Keypair }) => Promise<CommonRuntime>;
  readonly now: () => Date;
  readonly out: (line: string) => void;
  /** Data-API request cap for this invocation; defaults to the job's. */
  readonly maxApiCallsPerRun?: number;
}

export interface SettleNowResult {
  readonly settled: number;
  readonly failed: number;
  /** Groups left for another invocation (data-API cap or rate-limit backoff). */
  readonly deferred: number;
}

export async function settleNow(params: SettleNowParams): Promise<SettleNowResult> {
  const args = parseSettleNowArgs(params.argv);
  // The guard runs before anything is loaded or sent, and its errors never contain the RPC URL.
  const cluster = await params.assertCluster({
    cluster: params.cluster,
    rpcUrl: params.rpcUrl,
    getGenesisHash: params.getGenesisHash,
  });
  let payer: Keypair;
  try {
    payer = params.loadKeypair(args.payer);
  } catch {
    // No path, no file content: just that it failed.
    throw new Error("cannot load the payer keypair: check the path and that it is a keypair file");
  }
  const runtime = await params.runtime({ cluster, payer });
  const result = await runSettlement({
    now: params.now,
    chain: runtime.chain,
    verifyClose: runtime.verifyClose,
    adapter: runtime.adapter,
    buildSettleIxs: runtime.buildSettleIxs,
    payer: payer.publicKey,
    executor: runtime.executor,
    pyth: runtime.pyth,
    alerter: runtime.alerter satisfies AlerterLike,
    incidents: runtime.incidents,
    state: new RunState(),
    log: runtime.log,
    options: {
      ...JOB_OPTIONS,
      delaySecs: 0,
      windowMs: 0,
      ...(params.maxApiCallsPerRun === undefined
        ? {}
        : { maxApiCallsPerRun: params.maxApiCallsPerRun }),
      ...(args.date === undefined ? {} : { onlyDate: args.date }),
    },
  });
  if (result.status === "idle" && result.skipped.length === 0 && result.deferred.length === 0) {
    params.out("nothing to settle: no open market is past its close time");
  } else {
    params.out(`settled ${String(result.settled)} market(s) on ${cluster}`);
  }
  for (const failure of result.failures) {
    params.out(`FAILED ${failure.group}: ${failure.reason}`);
  }
  for (const skip of result.skipped) {
    params.out(
      `SKIPPED ${skip.group}: ${skip.reason} (no completed session; use the admin override)`,
    );
  }
  for (const group of result.deferred) {
    params.out(
      `DEFERRED ${group}: data-API budget or rate-limit backoff; run settle-now again in a minute`,
    );
  }
  return {
    settled: result.settled,
    failed: result.failures.length,
    deferred: result.deferred.length,
  };
}
