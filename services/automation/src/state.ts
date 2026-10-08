/**
 * In-memory run log behind `GET /health` (architecture.md: "automation keeps run logs"; no
 * persistent state is required). Records the last morning and settlement run and the most
 * recent failures.
 */
import type { IsoDate } from "./calendar";

export type RunStatus = "ok" | "skipped" | "failed";

export interface RunRecord {
  readonly job: "morning" | "settlement";
  readonly tradingDate: IsoDate;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Markets created / that already existed (morning). */
  readonly created: number;
  readonly existed: number;
  readonly attempts: number;
  /** Markets settled by this run (settlement). */
  readonly settled?: number;
  /** Why it failed or was skipped. */
  readonly notes: readonly string[];
}

export interface FailureRecord {
  readonly at: string;
  readonly job: string;
  readonly message: string;
}

const MAX_FAILURES = 50;

export class RunState {
  private morning: RunRecord | null = null;
  private settlement: RunRecord | null = null;
  private readonly failureLog: FailureRecord[] = [];

  record(run: RunRecord): void {
    if (run.job === "morning") {
      this.morning = run;
    } else {
      this.settlement = run;
    }
    if (run.status === "failed") {
      this.failure(run.job, run.notes.join("; "), run.finishedAt);
    }
  }

  failure(job: string, message: string, at: string = new Date().toISOString()): void {
    this.failureLog.push({ at, job, message });
    if (this.failureLog.length > MAX_FAILURES) {
      this.failureLog.shift();
    }
  }

  get lastMorning(): RunRecord | null {
    return this.morning;
  }

  get lastSettlement(): RunRecord | null {
    return this.settlement;
  }

  get failures(): readonly FailureRecord[] {
    return [...this.failureLog];
  }
}
