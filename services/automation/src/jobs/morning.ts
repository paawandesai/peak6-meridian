/**
 * The morning job (FR-13, FR-15; domain.md § Market lifecycle and time rules): at 08:00 ET on
 * trading days, read each ticker's previous official close from the two data sources (they must
 * agree, `prevCloses`), compute the strike ladder and create the missing markets through the
 * same code path as the `create-markets` CLI (M1-10). A ticker that fails (a source down or
 * disagreeing, an RPC error) is retried with backoff until 08:30 ET; if any ticker is still
 * failing then, exactly one alert is sent. Re-running creates nothing twice (NFR-05).
 *
 * Time, sleeping, HTTP and the chain are injected, so tests use a fixed clock and fakes.
 */
import { DateTime } from "luxon";

import { describeError, type Logger } from "../log";
import { type Alerter } from "../alerts";
import {
  closeTimeET,
  ET_ZONE,
  isTradingDay,
  previousTradingDay,
  tradingDateET,
  type IsoDate,
} from "../calendar";
import { createMarkets, planMarkets, TICKERS, type MarketOps } from "../cli/createMarkets";
import type { PrevCloseResult } from "../prevCloses";
import type { RunState } from "../state";

/** Cron expression of the job: 08:00 ET, Monday to Friday (holidays are filtered by the calendar). */
export const MORNING_CRON = "0 8 * * 1-5";
/** Retries stop at this ET wall-clock time. */
export const MORNING_DEADLINE_ET = { hour: 8, minute: 30 } as const;

const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 240_000;

export interface MorningDeps {
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /** The previous official close of `ticker` for the ET date `date` (both sources). */
  readonly prevClose: (ticker: string, date: IsoDate) => Promise<PrevCloseResult>;
  readonly marketOps: MarketOps;
  readonly alerter: Alerter;
  readonly state: RunState;
  readonly log: Logger;
  /** Overrides the calendar's `close_ts` (end-to-end runs only). */
  readonly closeTsOverride?: number;
  /** Demo mode ("replay" or "live"); creates short-close markets on devnet only. */
  readonly demoMode: "replay" | "live";
  /** Demo close time in seconds from now (devnet only). */
  readonly demoCloseInSecs: number;
  /** Solana cluster ("localnet", "devnet", or RPC URL). */
  readonly cluster: string;
}

export interface MorningResult {
  readonly status: "ok" | "skipped" | "failed";
  readonly tradingDate: IsoDate;
  readonly created: number;
  readonly existed: number;
  readonly attempts: number;
  /** Tickers that still had no markets when the job gave up. */
  readonly failedTickers: readonly string[];
}

/** Delay before retry number `attempt` (1-based): 15 s, 30 s, 60 s, … capped at 4 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempt - 1), MAX_RETRY_MS);
}

/** 08:30 ET on the date, as epoch milliseconds. */
export function morningDeadline(date: IsoDate): number {
  return DateTime.fromISO(date, { zone: ET_ZONE }).set(MORNING_DEADLINE_ET).toMillis();
}

/**
 * Whether a freshly started service should run the morning job now (startup catch-up): it is a
 * trading day, the 08:00 ET trigger has passed (so a restart or downtime after 08:00 did not
 * leave the day without markets) and the market has not closed yet. The run is idempotent, so a
 * catch-up over markets that already exist creates nothing. A date the calendar cannot answer
 * counts as due, so `runMorning` fails loudly with its single alert instead of staying silent.
 */
export function catchUpDue(now: Date): boolean {
  const date = tradingDateET(now);
  try {
    if (!isTradingDay(date)) {
      return false;
    }
    const trigger = DateTime.fromISO(date, { zone: ET_ZONE })
      .set({ hour: 8, minute: 0 })
      .toMillis();
    return now.getTime() >= trigger && now.getTime() < closeTimeET(date).closeTs * 1_000;
  } catch {
    return true;
  }
}

export async function runMorning(deps: MorningDeps): Promise<MorningResult> {
  const startedAt = deps.now();
  const tradingDate = tradingDateET(startedAt);
  const record = (
    status: MorningResult["status"],
    totals: { created: number; existed: number; attempts: number },
    notes: string[],
  ): void => {
    deps.state.record({
      job: "morning",
      tradingDate,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: deps.now().toISOString(),
      ...totals,
      notes,
    });
  };

  let dayInfo: { prevDate: IsoDate };
  try {
    if (!isTradingDay(tradingDate)) {
      deps.log("info", "morning_skipped", { tradingDate, reason: "not a trading day" });
      record("skipped", { created: 0, existed: 0, attempts: 0 }, ["not a trading day"]);
      return {
        status: "skipped",
        tradingDate,
        created: 0,
        existed: 0,
        attempts: 0,
        failedTickers: [],
      };
    }
    closeTimeET(tradingDate);
    dayInfo = { prevDate: previousTradingDay(tradingDate) };
  } catch (error) {
    // The calendar does not cover this date (e.g. a new year): fail loudly, once, no retries.
    const message = `calendar: ${describeError(error)}`;
    record("failed", { created: 0, existed: 0, attempts: 0 }, [message]);
    await deps.alerter.send({
      kind: "morning_failed",
      summary: `morning job cannot run for ${tradingDate}: ${message}`,
      details: { tradingDate },
    });
    return {
      status: "failed",
      tradingDate,
      created: 0,
      existed: 0,
      attempts: 0,
      failedTickers: [...TICKERS],
    };
  }

  const deadline = morningDeadline(tradingDate);
  const pending = new Set<string>(TICKERS);
  const lastError = new Map<string, string>();
  let created = 0;
  let existed = 0;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    for (const ticker of [...pending]) {
      const outcome = await processTicker(deps, ticker, tradingDate, dayInfo.prevDate);
      if (outcome.ok) {
        pending.delete(ticker);
        lastError.delete(ticker);
        created += outcome.created;
        existed += outcome.existed;
      } else {
        lastError.set(ticker, outcome.message);
      }
    }
    if (pending.size === 0) {
      deps.log("info", "morning_ok", { tradingDate, created, existed, attempts });
      record("ok", { created, existed, attempts }, []);
      return { status: "ok", tradingDate, created, existed, attempts, failedTickers: [] };
    }
    // The last delay is clamped to the deadline, so there is a final attempt at 08:30 ET and an
    // alert means "still failing at 08:30", not "the next backoff would have crossed it".
    const remaining = deadline - deps.now().getTime();
    if (remaining <= 0) {
      break;
    }
    const delay = Math.min(backoffMs(attempts), remaining);
    deps.log("warn", "morning_retry", {
      tradingDate,
      attempt: attempts,
      pending: [...pending],
      nextDelayMs: delay,
    });
    await deps.sleep(delay);
  }

  const failedTickers = [...pending];
  const notes = failedTickers.map((t) => `${t}: ${lastError.get(t) ?? "unknown"}`);
  record("failed", { created, existed, attempts }, notes);
  await deps.alerter.send({
    kind: "morning_failed",
    summary: `no markets for ${failedTickers.join(", ")} on ${tradingDate} after ${String(attempts)} attempts`,
    details: { tradingDate, failedTickers, reasons: notes, attempts },
  });
  return { status: "failed", tradingDate, created, existed, attempts, failedTickers };
}

type TickerOutcome =
  | { readonly ok: true; readonly created: number; readonly existed: number }
  | { readonly ok: false; readonly message: string };

/** One ticker: previous close from both sources, strikes, create what is missing. */
async function processTicker(
  deps: MorningDeps,
  ticker: string,
  tradingDate: IsoDate,
  prevDate: IsoDate,
): Promise<TickerOutcome> {
  try {
    const close = await deps.prevClose(ticker, prevDate);
    if (!close.ok) {
      deps.log("warn", "prev_close_unavailable", {
        ticker,
        prevDate,
        kind: close.error.kind,
        message: close.error.message,
      });
      return { ok: false, message: `${close.error.kind}: ${close.error.message}` };
    }

    // Demo mode: short-close markets (devnet only).
    let closeTs: number | undefined = deps.closeTsOverride;
    if (deps.demoMode === "replay" && closeTs === undefined) {
      if (deps.cluster !== "devnet") {
        throw new Error("demo mode requires devnet cluster");
      }
      closeTs = Math.floor(deps.now().getTime() / 1000) + deps.demoCloseInSecs;
    }

    const plan = planMarkets({
      tradingDate,
      closes: { [ticker]: close.value.closeCents },
      ...(closeTs === undefined ? {} : { closeTs }),
    });
    const report = await createMarkets(plan, deps.marketOps, (planned, signature) => {
      deps.log("info", "market_created", {
        ticker,
        strikeCents: planned.key.strikeCents.toString(),
        signature,
      });
    });
    return { ok: true, created: report.created.length, existed: report.skipped.length };
  } catch (error) {
    const message = describeError(error);
    deps.log("warn", "morning_ticker_error", { ticker, message });
    return { ok: false, message };
  }
}
