/**
 * Time in ET and the header's next-close rule (docs/design.md §3 "Data staleness and time").
 * Everything takes an injected `nowSecs`; nothing here reads a clock. ET comes from the
 * platform's IANA support (`Intl.DateTimeFormat`, `America/New_York`), which handles DST with no
 * dependency, no UTC offsets and no calendar in the app.
 */
import { closeTimeET, isTradingDay, nextTradingDay, tradingDateET } from "@meridian/client";
import { marketStatus, type MarketRow } from "./markets";

const ZONE = "America/New_York";

const hms = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const hm = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const hm12 = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const weekday = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  weekday: "short",
});
const ymd = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Placeholder rendered on the server and on the first client render (no hydration mismatch). */
export const CLOCK_PLACEHOLDER = "--:--:-- ET";

/** `14:52:07` for unix seconds, in ET. */
export function formatEtHms(unixSecs: number | bigint): string {
  return hms.format(new Date(Number(unixSecs) * 1000));
}

const monthDay = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  month: "short",
  day: "numeric",
});

/**
 * `19:59:59` when `unixSecs` is on today's ET date, `Fri 19:59:59` within the last week, and
 * `Fri Oct 2 19:59:59` before that (a bare weekday would be ambiguous), all in ET.
 */
export function formatEtDayHms(unixSecs: number, nowSecs: number): string {
  const time = formatEtHms(unixSecs);
  if (etTradingDate(unixSecs) === etTradingDate(nowSecs)) return time;
  const date = new Date(unixSecs * 1000);
  const day = weekday.format(date);
  const withinWeek = Math.abs(nowSecs - unixSecs) < 6 * 86_400;
  return withinWeek ? `${day} ${time}` : `${day} ${monthDay.format(date)} ${time}`;
}

/** `16:05` for unix seconds, in ET (24-hour). */
export function formatEtHm(unixSecs: number | bigint): string {
  return hm.format(new Date(Number(unixSecs) * 1000));
}

/** `4:05 PM` for unix seconds, in ET (12-hour with AM/PM). */
export function formatEtHm12(unixSecs: number | bigint): string {
  return hm12.format(new Date(Number(unixSecs) * 1000));
}

/** The ET calendar date as a `YYYYMMDD` number (the on-chain `trading_date` form). */
export function etTradingDate(unixSecs: number): number {
  const parts = ymd.formatToParts(new Date(unixSecs * 1000));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return Number(`${pick("year")}${pick("month")}${pick("day")}`);
}

/** `12:04` for under an hour, `1:12:04` from an hour on; never negative. */
export function formatCountdown(totalSecs: number): string {
  const secs = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const two = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/**
 * The active date's markets (design.md §2 "Trading-date scoping"): today's ET trading date when
 * the loaded markets include it, otherwise the most recent trading date present.
 */
export function activeDateMarkets(markets: readonly MarketRow[], nowSecs: number): MarketRow[] {
  if (markets.length === 0) return [];
  const today = etTradingDate(nowSecs);
  const hasToday = markets.some((market) => market.tradingDate === today);
  const date = hasToday ? today : Math.max(...markets.map((market) => market.tradingDate));
  return markets.filter((market) => market.tradingDate === date);
}

export type NextClose =
  | { readonly kind: "none" } // "No markets today"
  | {
      readonly kind: "countdown";
      readonly closeTs: bigint;
      readonly secondsLeft: number;
      readonly hourET: 16 | 13;
    }
  | { readonly kind: "closed-settling"; readonly settlingAt: bigint | null } // "Closed · settling at 4:05 PM ET"
  | { readonly kind: "settlement-delayed" } // "Settlement delayed"
  | {
      readonly kind: "next-session";
      readonly dayName: string;
      readonly openTime: string;
    } // "Next session Mon 9:30 AM ET"
  | { readonly kind: "markets-closed" }; // "Markets closed"

/**
 * The header's next-close state (P0-1 updated). The target is the session close of the active
 * date, computed from session markets only (markets whose `close_ts` matches the NYSE session
 * close for their trading date). Non-session markets (test markets) never drive the header.
 * Early-close days need no calendar: the session close is read from the on-chain market.
 * The header never counts down to a time it computed itself.
 */
export function nextClose(markets: readonly MarketRow[], nowSecs: number): NextClose {
  const now = BigInt(nowSecs);

  // Filter to session markets only (P0-1): markets whose closeTs matches their trading date's
  // session close. Test markets are excluded.
  const sessionMarkets = markets.filter((market) => {
    const sessionClose = sessionCloseTs(market.tradingDate);
    return sessionClose !== null && Number(market.closeTs) === sessionClose;
  });

  // Look at session markets only, across all trading dates
  const open = sessionMarkets.filter((market) => !market.settled && now < market.closeTs);
  if (open.length > 0) {
    const closeTs = open.reduce(
      (min, market) => (market.closeTs < min ? market.closeTs : min),
      open[0]?.closeTs ?? 0n,
    );
    // Determine hourET from the closeTs (16:00 or 13:00)
    const hourET = Number(formatEtHms(closeTs).slice(0, 2)) as 16 | 13;
    return { kind: "countdown", closeTs, secondsLeft: Number(closeTs - now), hourET };
  }

  const unsettled = sessionMarkets.filter((market) => !market.settled);
  if (unsettled.length === 0) {
    // P0-1 weekend AC: show next session only on weekends/holidays
    try {
      const todayEt = tradingDateET(new Date(nowSecs * 1000));

      // When no markets loaded: next-session on weekends/holidays, none on trading days
      if (markets.length === 0) {
        if (!isTradingDay(todayEt)) {
          const nextDay = nextTradingDay(todayEt);
          const dayName = weekday.format(new Date(`${nextDay}T12:00:00Z`));
          return { kind: "next-session", dayName, openTime: "9:30 AM" };
        }
        return { kind: "none" };
      }

      // On weekends/holidays with settled markets, show next session
      if (!isTradingDay(todayEt)) {
        const nextDay = nextTradingDay(todayEt);
        const dayName = weekday.format(new Date(`${nextDay}T12:00:00Z`));
        return { kind: "next-session", dayName, openTime: "9:30 AM" };
      }

      // On trading days, all session markets settled: show "Markets closed"
      return { kind: "markets-closed" };
    } catch {
      // Outside supported years or calendar unavailable
      if (markets.length === 0) return { kind: "none" };
      return { kind: "markets-closed" };
    }
  }
  // Settlement delayed wins: it is the state that needs attention.
  if (unsettled.some((market) => marketStatus(market, nowSecs) === "SettlementDelayed")) {
    return { kind: "settlement-delayed" };
  }
  // "Closed · settling at 4:05 PM ET" - settlement starts at close + 5 min
  const firstUnsettled = unsettled[0];
  const settlingAt = firstUnsettled ? firstUnsettled.closeTs + 5n * 60n : null;
  return { kind: "closed-settling", settlingAt };
}

/**
 * Session close time for a trading date (P0-1). Returns unix seconds of the NYSE session close:
 * 16:00 ET on regular days, 13:00 ET on early-close days.
 *
 * @param tradingDate `YYYYMMDD` number as stored on-chain.
 * @returns Unix seconds of the session close (16:00 or 13:00 ET), or null if not a valid trading day.
 */
export function sessionCloseTs(tradingDate: number): number | null {
  try {
    const text = String(tradingDate).padStart(8, "0");
    const isoDate = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    return closeTimeET(isoDate).closeTs;
  } catch {
    // Not a trading day or outside supported years
    return null;
  }
}
