/**
 * Demo-session registry (`deployments/demo-sessions.json`): the schema shared by the
 * `make demo-markets` / `make demo-settle` scripts (writers) and the app's DEMO banner (reader).
 *
 * A demo session is a set of markets created on a NON-trading day (weekend or NYSE holiday) so
 * they never collide with the automation's real markets, with a real future `close_ts`, and
 * strikes built from the previous close of a real session (`asOf`) exactly as the morning job
 * would have built them. The admin settles them by override at the `asOf` session's real close.
 *
 * Dependency-free beyond zod and the shared NYSE calendar, so the app can import it.
 */
import { z } from "zod";

import { isTradingDay } from "./calendar";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER = /^[A-Z]{1,8}$/;

/** `YYYY-MM-DD` naming a real calendar date (`2026-02-30` is refused). */
const isoDate = z
  .string()
  .regex(ISO_DATE, "expected YYYY-MM-DD")
  .refine((text) => {
    const parsed = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text);
  }, "not a real calendar date");

const ticker = z.string().regex(TICKER, "expected an upper-case ticker");
const cents = z.number().int().positive();

/** One demo session: the markets of one non-trading `tradingDate`. */
export const demoSessionSchema = z.object({
  /** ET date the markets are keyed by on chain (`trading_date`), a non-trading day, `YYYY-MM-DD`. */
  tradingDate: isoDate,
  /** The real NYSE session this demo simulates, `YYYY-MM-DD`. */
  asOf: isoDate,
  /** On-chain `close_ts` of every market of the session, unix seconds. */
  closeTs: z.number().int().positive(),
  /** When the session was first registered, ISO-8601 UTC. */
  createdAt: z.iso.datetime(),
  /** Tickers that have markets in the session. */
  tickers: z.array(ticker).min(1),
  /** Strikes per ticker, integer cents, ascending (the morning job's ladder for `asOf`). */
  strikesByTicker: z.record(ticker, z.array(cents).min(1)),
  /**
   * The `asOf` session's official close per ticker, integer cents: the demo-settle price.
   * Partial or empty until known (the session may not have closed when the markets were made).
   */
  asOfCloseCentsByTicker: z.record(ticker, cents),
  /** The session before `asOf` (the strike basis), `YYYY-MM-DD`. Optional, for audit. */
  prevCloseDate: isoDate.optional(),
  /** The strike basis per ticker, integer cents. Optional, for audit. */
  prevCloseCentsByTicker: z.record(ticker, cents).optional(),
});
export type DemoSession = z.infer<typeof demoSessionSchema>;

/** The whole registry file. At most one session per `tradingDate`. */
export const demoSessionsSchema = z
  .object({ sessions: z.array(demoSessionSchema) })
  .refine(
    (registry) =>
      new Set(registry.sessions.map((session) => session.tradingDate)).size ===
      registry.sessions.length,
    "duplicate tradingDate in the demo-session registry",
  );
export type DemoSessions = z.infer<typeof demoSessionsSchema>;

/** `20261011`, `"20261011"` or `"2026-10-11"` as `"2026-10-11"`; null when not a real date. */
export function toIsoTradingDate(date: number | string): string | null {
  const text = String(date);
  const iso = /^\d{8}$/.test(text)
    ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
    : text;
  return isoDate.safeParse(iso).success ? iso : null;
}

/**
 * True when the date (on-chain `YYYYMMDD`, or `YYYY-MM-DD`) is NOT an NYSE trading day: a
 * weekend or an NYSE holiday, where only demo markets ever live. False for a trading day, for
 * a malformed date, and for a weekday outside the calendar's holiday tables (unknown: not
 * claimed as demo).
 */
export function isDemoTradingDate(yyyymmdd: number | string): boolean {
  const iso = toIsoTradingDate(yyyymmdd);
  if (iso === null) {
    return false;
  }
  const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return true;
  }
  try {
    return !isTradingDay(iso);
  } catch {
    return false;
  }
}

/** The registered session for a trading date (any accepted date form), if any. */
export function findDemoSession(
  registry: DemoSessions,
  tradingDate: number | string,
): DemoSession | undefined {
  const iso = toIsoTradingDate(tradingDate);
  return iso === null
    ? undefined
    : registry.sessions.find((session) => session.tradingDate === iso);
}
