/**
 * Pacing rules of the settlement job (#53): which groups may touch the data APIs at all, how many
 * requests one run may make, and how long to back off after a rate limit. Pure functions only, so
 * the scheduling and backoff logic is property-tested without a clock or a network.
 *
 * Background: every settlement attempt asks Tiingo and Twelve Data for the official close, and a
 * successful one also has the Switchboard oracles fetch the same APIs with our keys. Twelve Data's
 * free tier allows about 8 requests a minute and 800 a day, and the morning job needs that quota
 * at 08:00 ET, so the job must never burst.
 */
import { closeTimeET, isTradingDay, type IsoDate } from "./calendar";

/**
 * Default cap on data-API requests per run (the job runs every minute), sized for Twelve Data's
 * free tier of 8 requests a minute: each attempt asks each source at most once, so a run asks
 * Twelve Data at most `cap / 2` times. Override with `SETTLE_MAX_API_CALLS_PER_RUN`.
 */
export const DEFAULT_MAX_API_CALLS_PER_RUN = 8;
/** The verification asks each of the two sources at most once (Tiingo, then Twelve Data). */
export const VERIFY_API_CALLS = 2;
/** A Switchboard update has the oracles fetch both sources once (one feed per source). */
export const ORACLE_API_CALLS_PER_UPDATE = 2;
/** First wait after a rate limit; doubles with each consecutive rate limit. */
export const BACKOFF_BASE_MS = 2 * 60_000;
/** No wait is longer than this, even when `Retry-After` asks for more. */
export const BACKOFF_CAP_MS = 60 * 60_000;

/** Exponential backoff for the n-th consecutive rate limit (n ≥ 1): 2, 4, 8, ... capped at 60 min. */
export function rateLimitBackoffMs(strikes: number): number {
  if (!Number.isInteger(strikes) || strikes <= 0) {
    return 0;
  }
  // 2^5 × 2 min already exceeds the cap; clamping the exponent avoids huge intermediates.
  const exponent = Math.min(strikes - 1, 6);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
}

const DELTA_SECONDS = /^\d{1,10}$/;

/**
 * `Retry-After` as milliseconds from `nowMs`: either delta-seconds or an HTTP date. Null when the
 * header is absent or not one of those forms (the header is external input: never trusted blindly).
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = value.trim();
  if (DELTA_SECONDS.test(text)) {
    return Number(text) * 1_000;
  }
  // HTTP dates always name the weekday and GMT, e.g. "Sat, 10 Oct 2026 21:00:00 GMT".
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    return null;
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/**
 * When data-API requests may resume after the `strikes`-th consecutive rate limit: the larger of
 * the exponential backoff and the source's `Retry-After`, never more than BACKOFF_CAP_MS.
 */
export function backoffUntil(nowMs: number, strikes: number, retryAfterMs: number | null): number {
  const wait = Math.max(rateLimitBackoffMs(strikes), retryAfterMs ?? 0);
  return nowMs + Math.min(wait, BACKOFF_CAP_MS);
}

/** Data-API requests one settlement attempt may cause, reserved before it starts. */
export function attemptCost(adapterKind: "switchboard" | "local"): number {
  return VERIFY_API_CALLS + (adapterKind === "switchboard" ? ORACLE_API_CALLS_PER_UPDATE : 0);
}

export type SkipReason = "not_a_trading_day" | "session_not_closed" | "outside_calendar";

export type SessionGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SkipReason; readonly detail: string };

/**
 * Whether the regular session of `date` has completed, in real time, at least `delaySecs` ago:
 * the date must be an NYSE trading day and its official close (16:00 ET, or 13:00 ET on early
 * closes) plus the delay must have passed. The market's on-chain `close_ts` plays no part: a market
 * created with an early `close_ts`, or on a weekend for a demo, must not make the job ask the data
 * APIs for a bar that does not exist yet (or ever). Such markets are left to the admin override.
 */
export function sessionGate(date: IsoDate, nowMs: number, delaySecs: number): SessionGate {
  try {
    if (!isTradingDay(date)) {
      return { ok: false, reason: "not_a_trading_day", detail: `${date} has no NYSE session` };
    }
    const dueMs = (closeTimeET(date).closeTs + delaySecs) * 1_000;
    if (nowMs < dueMs) {
      return {
        ok: false,
        reason: "session_not_closed",
        detail: `the ${date} session is not settleable before ${new Date(dueMs).toISOString()}`,
      };
    }
    return { ok: true };
  } catch (error) {
    // The calendar refuses dates outside its checked holiday tables rather than guessing.
    if (error instanceof RangeError) {
      return { ok: false, reason: "outside_calendar", detail: error.message };
    }
    throw error;
  }
}
