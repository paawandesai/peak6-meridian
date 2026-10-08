/**
 * Time in ET and the header's next-close rule (docs/design.md §3 "Data staleness and time").
 * Everything takes an injected `nowSecs`; nothing here reads a clock. ET comes from the
 * platform's IANA support (`Intl.DateTimeFormat`, `America/New_York`), which handles DST with no
 * dependency, no UTC offsets and no calendar in the app.
 */
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

/** `16:05` for unix seconds, in ET. */
export function formatEtHm(unixSecs: number | bigint): string {
  return hm.format(new Date(Number(unixSecs) * 1000));
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
  | { readonly kind: "countdown"; readonly closeTs: bigint; readonly secondsLeft: number }
  | { readonly kind: "closed-settling" } // "Closed · settling"
  | { readonly kind: "settlement-delayed" } // "Settlement delayed"
  | { readonly kind: "markets-closed" }; // "Markets closed"

/**
 * The header's next-close state. The target is the smallest on-chain `close_ts` with
 * `now < close_ts` among the active date's markets whose on-chain status is `Open` (not settled),
 * so Open and Closing soon both count and early-close days need no calendar. The header never
 * counts down to a time it computed itself.
 */
export function nextClose(markets: readonly MarketRow[], nowSecs: number): NextClose {
  const active = activeDateMarkets(markets, nowSecs);
  if (active.length === 0) return { kind: "none" };
  const now = BigInt(nowSecs);
  const open = active.filter((market) => !market.settled && now < market.closeTs);
  if (open.length > 0) {
    const closeTs = open.reduce(
      (min, market) => (market.closeTs < min ? market.closeTs : min),
      open[0]?.closeTs ?? 0n,
    );
    return { kind: "countdown", closeTs, secondsLeft: Number(closeTs - now) };
  }
  const unsettled = active.filter((market) => !market.settled);
  if (unsettled.length === 0) return { kind: "markets-closed" };
  // Settlement delayed wins: it is the state that needs attention.
  return unsettled.some((market) => marketStatus(market, nowSecs) === "SettlementDelayed")
    ? { kind: "settlement-delayed" }
    : { kind: "closed-settling" };
}
