/**
 * The automation service: verifies the automation key against the on-chain config, schedules the
 * jobs and serves `/health`.
 *
 * Degraded modes (M2-03 AC5, AC5b); the HTTP server and `/health` stay up in both and one alert
 * is sent:
 * - key mismatch (the loaded key is not `config.automation_authority`): the morning job, the
 *   only action that needs that key (`create_strike_market`, AB-19), is not scheduled;
 *   `/health` reports `unhealthy: automation key mismatch`; the settlement job keeps running,
 *   signing with the loaded key, because `settle_market` is permissionless (NFR-04);
 * - key missing or unparseable: no signer exists, so both jobs are disabled; `/health` reports
 *   `unhealthy: automation key missing or invalid`. Recovery is fixing the env and redeploying.
 */
import type { AddressInfo } from "node:net";

import type { Keypair, PublicKey } from "@solana/web3.js";

import type { Alert, Alerter } from "./alerts";
import {
  catchUpDue,
  runMorning,
  MORNING_CRON,
  type MorningDeps,
  type MorningResult,
} from "./jobs/morning";
import { describeError, type Logger } from "./log";
import { marketsResponse, type OpenTimeIndex } from "./openTimes";
import { scheduleJobs, type CronLike, type JobSpec, type ScheduledJob } from "./scheduler";
import { createHealthServer } from "./server";
import { RunState } from "./state";

export const KEY_MISMATCH = "automation key mismatch";
export const KEY_MISSING = "automation key missing or invalid";

/** What depends on the automation key; built only when a key was loaded. */
export interface SignerDeps {
  /** `config.automation_authority` read from the chain; a failure aborts startup. */
  readonly readAutomationAuthority: () => Promise<PublicKey>;
  /** Everything the morning job needs except what the service supplies. */
  readonly morning: Omit<MorningDeps, "alerter" | "state" | "log">;
  /** The settlement job, built with the loaded key as its signer. */
  readonly settlement: JobSpec;
  /** Runs once at startup (e.g. the payer balance check); a failure is logged, never fatal. */
  readonly startupCheck?: () => Promise<void>;
}

export interface ServiceDeps {
  readonly serviceToken: string;
  /** 0 picks a free port. */
  readonly port: number;
  readonly host?: string;
  /** The loaded `AUTOMATION_KEYPAIR`, or null when it was missing or unparseable. */
  readonly signer: Keypair | null;
  /** Builds the key-dependent parts; called only when `signer` is not null. */
  readonly withSigner: (signer: Keypair) => Promise<SignerDeps>;
  readonly cron: CronLike;
  readonly alerter: Alerter;
  readonly log: Logger;
  readonly state?: RunState;
  readonly now?: () => Date;
  /** Delay between the startup config reads; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The market open-time index behind `GET /markets` (P1-4). Built without the signer, so it is
   * served in every degraded mode; the route is 404 when absent.
   */
  readonly openTimes?: OpenTimeIndex;
}

/** `/markets` answers within this, with what the index holds, even while a refresh runs. */
export const MARKETS_WAIT_MS = 2_500;

/** Startup reads of the config are tried this many times, waiting 2 s, 4 s, … between them. */
export const STARTUP_ATTEMPTS = 3;
const STARTUP_RETRY_MS = 2_000;

export interface HealthReport {
  readonly service: "automation";
  readonly status: "ok" | "unhealthy";
  /** Present only when unhealthy, e.g. `automation key mismatch`. */
  readonly unhealthy?: string;
  readonly startedAt: string;
  readonly jobs: readonly {
    readonly name: string;
    readonly cron?: string;
    readonly signer?: string;
    readonly scheduled: boolean;
    readonly disabled?: string;
  }[];
  readonly lastMorning: RunState["lastMorning"];
  readonly lastSettlement: RunState["lastSettlement"];
  readonly failures: RunState["failures"];
}

export interface RunningService {
  readonly port: number;
  /** Why the morning job is disabled, or null. */
  readonly degraded: string | null;
  readonly jobs: readonly ScheduledJob[];
  readonly state: RunState;
  /**
   * The startup catch-up run of the morning job (null when none was due or the morning job is
   * disabled). Not awaited by `startService`: it may retry for up to 30 minutes.
   */
  readonly catchUp: Promise<MorningResult | null>;
  health(): HealthReport;
  stop(): Promise<void>;
}

/**
 * Builds the key-dependent deps and reads `config.automation_authority`, retrying a few times so
 * an RPC blip at deploy time does not kill the service. After the last failure it sends one
 * `startup_failed` alert (there is no `/health` yet) and rethrows, so the supervisor restarts it.
 */
async function readConfigWithRetry(
  deps: ServiceDeps,
  signer: Keypair,
): Promise<{ signerDeps: SignerDeps; authority: PublicKey }> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      const signerDeps = await deps.withSigner(signer);
      return { signerDeps, authority: await signerDeps.readAutomationAuthority() };
    } catch (error) {
      const message = describeError(error);
      deps.log("warn", "startup_config_read_failed", { attempt, message });
      if (attempt >= STARTUP_ATTEMPTS) {
        await deps.alerter.send({
          kind: "startup_failed",
          summary: `the service cannot read its config after ${String(attempt)} attempts and is exiting: ${message}`,
          details: { attempts: attempt },
        });
        throw error;
      }
      await sleep(STARTUP_RETRY_MS * 2 ** (attempt - 1));
    }
  }
}

export async function startService(deps: ServiceDeps): Promise<RunningService> {
  const now = deps.now ?? (() => new Date());
  const state = deps.state ?? new RunState();
  const startedAt = now().toISOString();
  const openTimes = deps.openTimes;
  // Each creation signature goes to the open-time index as it lands.
  type BaseMorning = Omit<MorningDeps, "alerter" | "state" | "log">;
  const morningWith = (base: BaseMorning): BaseMorning =>
    openTimes === undefined
      ? base
      : { ...base, onCreated: (signature: string) => openTimes.noteCreated(signature) };

  // Degraded when there is no key (AC5b: both jobs disabled, nothing can sign) or the key is not
  // the config's automation authority (AC5: only the morning job, which needs that key, is
  // disabled; settlement is permissionless and keeps running, NFR-04).
  let degraded: string | null = null;
  let disabled: string[] = [];
  const specs: JobSpec[] = [];
  let alert: Alert | null = null;
  let morningDeps: Omit<MorningDeps, "alerter" | "state" | "log"> | null = null;
  if (deps.signer === null) {
    degraded = KEY_MISSING;
    disabled = ["morning", "settlement"];
    alert = {
      kind: "automation_key_missing",
      summary:
        "AUTOMATION_KEYPAIR is missing or invalid, so no job can sign and both jobs are disabled. " +
        "Fix the environment and redeploy, or settle manually with the settle-now CLI (M2-04) using any funded devnet keypair.",
    };
  } else {
    const { signerDeps, authority } = await readConfigWithRetry(deps, deps.signer);
    await signerDeps.startupCheck?.().catch((error: unknown) => {
      deps.log("warn", "startup_check_failed", { error: describeError(error) });
    });
    specs.push(signerDeps.settlement);
    if (deps.signer.publicKey.equals(authority)) {
      morningDeps = signerDeps.morning;
      specs.push({
        name: "morning",
        cron: MORNING_CRON,
        signer: deps.signer.publicKey.toBase58(),
        run: async () => {
          await runMorning({
            ...morningWith(signerDeps.morning),
            alerter: deps.alerter,
            state,
            log: deps.log,
          });
        },
      });
    } else {
      degraded = KEY_MISMATCH;
      disabled = ["morning"];
      alert = {
        kind: "automation_key_mismatch",
        summary:
          "the loaded AUTOMATION_KEYPAIR is not config.automation_authority; the morning job is disabled, settlement keeps running",
        details: { configured: authority.toBase58(), loaded: deps.signer.publicKey.toBase58() },
      };
    }
  }
  const onCrash = async (job: string, message: string): Promise<void> => {
    // A crash is recorded for /health and alerted once per crash, never only logged.
    state.failure(job, `crashed: ${message}`);
    await deps.alerter.send({
      kind: "job_crashed",
      summary: `the ${job} job crashed: ${message}`,
      details: { job },
    });
  };
  const jobs = scheduleJobs(deps.cron, specs, deps.log, onCrash);

  if (degraded !== null && alert !== null) {
    deps.log("error", "degraded_mode", { reason: degraded });
    state.failure("startup", degraded);
    await deps.alerter.send(alert);
  }

  const health = (): HealthReport => ({
    service: "automation",
    status: degraded === null ? "ok" : "unhealthy",
    ...(degraded === null ? {} : { unhealthy: degraded }),
    startedAt,
    jobs: [
      ...jobs.map((job) => ({
        name: job.name,
        cron: job.cron,
        ...(job.signer === undefined ? {} : { signer: job.signer }),
        scheduled: true,
      })),
      ...disabled.map((name) => ({ name, scheduled: false, disabled: degraded ?? "" })),
    ],
    lastMorning: state.lastMorning,
    lastSettlement: state.lastSettlement,
    failures: state.failures,
  });

  const server = createHealthServer({
    token: deps.serviceToken,
    health,
    ...(openTimes === undefined
      ? {}
      : { markets: () => marketsResponse(openTimes, MARKETS_WAIT_MS) }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, deps.host ?? "0.0.0.0", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  deps.log("info", "service_started", { port, degraded, jobs: jobs.map((j) => j.name) });
  // Backfill the open-time index from the chain now, so the first `/markets` finds it ready.
  // Not awaited; failed attempts are logged by the index and retried with backoff.
  void openTimes?.backfill();

  // Startup catch-up: a restart or redeploy after 08:00 ET must not leave the day without markets.
  let catchUp: Promise<MorningResult | null> = Promise.resolve(null);
  if (morningDeps !== null && catchUpDue(morningDeps.now())) {
    const base = morningDeps;
    deps.log("info", "morning_catch_up", {});
    catchUp = runMorning({
      ...morningWith(base),
      alerter: deps.alerter,
      state,
      log: deps.log,
    }).catch(async (error: unknown) => {
      const message = describeError(error);
      deps.log("error", "job_crashed", { job: "morning", error: message });
      await onCrash("morning", message);
      return null;
    });
  }

  return {
    port,
    degraded,
    jobs,
    state,
    catchUp,
    health,
    stop: async () => {
      openTimes?.stop();
      for (const job of jobs) {
        job.handle.stop();
      }
      await new Promise<void>((resolve) => {
        server.close((error) => {
          if (error !== undefined) {
            deps.log("warn", "server_close_failed", { error: describeError(error) });
          }
          resolve();
        });
      });
    },
  };
}
