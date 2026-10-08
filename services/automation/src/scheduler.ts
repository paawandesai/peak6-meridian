/**
 * Cron scheduling in `America/New_York` (architecture.md: node-cron). The cron library is
 * injected so tests can drive jobs without real timers.
 */
import * as nodeCron from "node-cron";

import { ET_ZONE } from "./calendar";
import { describeError, type Logger } from "./log";

export interface JobSpec {
  readonly name: string;
  /** Cron expression, interpreted in `America/New_York`. */
  readonly cron: string;
  readonly run: () => Promise<void>;
  /** Public key of the account that signs this job's transactions, if it signs any. */
  readonly signer?: string;
}

export interface ScheduledHandle {
  stop(): void;
}

/** The subset of node-cron used here. */
export interface CronLike {
  schedule(
    expression: string,
    task: () => void | Promise<void>,
    options: { timezone: string; name: string; noOverlap: boolean },
  ): ScheduledHandle;
}

export const defaultCron: CronLike = nodeCron;

export interface ScheduledJob {
  readonly name: string;
  readonly cron: string;
  readonly signer?: string;
  readonly handle: ScheduledHandle;
}

/**
 * Schedules every spec. A job that throws never takes the process down: the crash is logged and
 * handed to `onCrash`, so it can be recorded in `/health` and alerted (it is never swallowed).
 */
export function scheduleJobs(
  cron: CronLike,
  specs: readonly JobSpec[],
  log: Logger,
  onCrash?: (job: string, message: string) => void | Promise<void>,
): ScheduledJob[] {
  return specs.map((spec) => ({
    name: spec.name,
    cron: spec.cron,
    ...(spec.signer === undefined ? {} : { signer: spec.signer }),
    handle: cron.schedule(
      spec.cron,
      async () => {
        try {
          await spec.run();
        } catch (error) {
          const message = describeError(error);
          log("error", "job_crashed", { job: spec.name, error: message });
          try {
            await onCrash?.(spec.name, message);
          } catch (reportError) {
            log("error", "job_crash_report_failed", {
              job: spec.name,
              error: describeError(reportError),
            });
          }
        }
      },
      { timezone: ET_ZONE, name: spec.name, noOverlap: true },
    ),
  }));
}
