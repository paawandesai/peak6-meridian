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
import { runMorning, MORNING_CRON, type MorningDeps } from "./jobs/morning";
import { describeError, type Logger } from "./log";
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
}

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

  // Degraded when there is no key (AC5b: both jobs disabled, nothing can sign) or the key is not
  // the config's automation authority (AC5: only the morning job, which needs that key, is
  // disabled; settlement is permissionless and keeps running, NFR-04).
  let degraded: string | null = null;
  let disabled: string[] = [];
  const specs: JobSpec[] = [];
  let alert: Alert | null = null;
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
    specs.push(signerDeps.settlement);
    if (deps.signer.publicKey.equals(authority)) {
      specs.push({
        name: "morning",
        cron: MORNING_CRON,
        signer: deps.signer.publicKey.toBase58(),
        run: async () => {
          await runMorning({ ...signerDeps.morning, alerter: deps.alerter, state, log: deps.log });
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
  const jobs = scheduleJobs(deps.cron, specs, deps.log, async (job, message) => {
    // A crash is recorded for /health and alerted once per crash, never only logged.
    state.failure(job, `crashed: ${message}`);
    await deps.alerter.send({
      kind: "job_crashed",
      summary: `the ${job} job crashed: ${message}`,
      details: { job },
    });
  });

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

  const server = createHealthServer({ token: deps.serviceToken, health });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, deps.host ?? "0.0.0.0", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  deps.log("info", "service_started", { port, degraded, jobs: jobs.map((j) => j.name) });

  return {
    port,
    degraded,
    jobs,
    state,
    health,
    stop: async () => {
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
