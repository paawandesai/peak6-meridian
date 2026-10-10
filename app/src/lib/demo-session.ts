/**
 * Demo-session markets: real, tradable devnet markets whose on-chain `trading_date` is a day NYSE
 * is closed (a weekend or holiday). They simulate a chosen real session (`asOf`) and close at
 * whatever `close_ts` the creating script wrote on-chain.
 *
 * The registry schema and date rules come from `@meridian/client` (`demo-sessions.ts`). The
 * registry itself (`deployments/demo-sessions.json`) is inlined at build time by
 * `next.config.mjs` as `NEXT_PUBLIC_DEMO_SESSIONS`, because it is committed data, not a secret.
 *
 * ET formatting goes through `Intl.DateTimeFormat` with `America/New_York`; no UTC offsets.
 */
import {
  demoSessionsSchema,
  findDemoSession as findInRegistry,
  isDemoTradingDate,
  toIsoTradingDate,
  type DemoSession,
} from "@meridian/client";

import type { MarketRow } from "./markets";

export { isDemoTradingDate, type DemoSession };

const ZONE = "America/New_York";

export type DemoRegistry = {
  readonly sessions: readonly DemoSession[];
  /** Set when the registry text was present but did not validate; the app then knows no asOf. */
  readonly error: string | null;
};

/** True when the number is a real calendar date in `YYYYMMDD` form. */
export function isValidYyyymmdd(value: number): boolean {
  return Number.isInteger(value) && value > 0 && toIsoTradingDate(value) !== null;
}

/** `20261011` → `2026-10-11`. */
export function isoFromYyyymmdd(value: number): string {
  const text = String(value).padStart(8, "0");
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

export function isDemoMarket(market: Pick<MarketRow, "tradingDate">): boolean {
  return isDemoTradingDate(market.tradingDate);
}

/**
 * Whether pages list a demo market by default (next to real session markets). A registered demo
 * session is always listed, settled or not, so its traders can find and redeem positions. An
 * unregistered non-trading-day market (a weekend test run, say) is listed only while unsettled;
 * once settled it goes back behind the "Show test markets" toggle, where it was before.
 */
export function isListedDemoMarket(
  market: Pick<MarketRow, "tradingDate" | "settled">,
  registry: DemoRegistry = demoRegistry(),
): boolean {
  if (!isDemoMarket(market)) return false;
  return !market.settled || findDemoSession(registry, market.tradingDate) !== undefined;
}

/** Validates registry text (JSON). Empty or missing text is an empty registry, not an error. */
export function parseDemoRegistry(text: string | undefined): DemoRegistry {
  if (text === undefined || text.trim() === "") return { sessions: [], error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { sessions: [], error: `demo-sessions.json is not JSON: ${String(error)}` };
  }
  const parsed = demoSessionsSchema.safeParse(raw);
  if (!parsed.success) {
    return { sessions: [], error: `demo-sessions.json is invalid: ${parsed.error.message}` };
  }
  return { sessions: parsed.data.sessions, error: null };
}

let cached: DemoRegistry | null = null;

/** The registry inlined at build time. Logged once, loudly, when it does not validate. */
export function demoRegistry(): DemoRegistry {
  if (cached === null) {
    cached = parseDemoRegistry(process.env.NEXT_PUBLIC_DEMO_SESSIONS);
    if (cached.error !== null) console.error(`[demo-session] ${cached.error}`);
  }
  return cached;
}

/** The registry entry for an on-chain `trading_date` (the schema allows one per date). */
export function findDemoSession(
  registry: DemoRegistry,
  tradingDate: number,
): DemoSession | undefined {
  return findInRegistry({ sessions: [...registry.sessions] }, tradingDate);
}

const etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const dateParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function pick(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

/** A calendar date (no time zone involved): `20261009` or `2026-10-09` → `Fri Oct 9, 2026`. */
export function formatCalendarDate(value: number | string): string {
  const iso = toIsoTradingDate(value) ?? String(value);
  const parts = dateParts.formatToParts(new Date(`${iso}T12:00:00Z`));
  return `${pick(parts, "weekday")} ${pick(parts, "month")} ${pick(parts, "day")}, ${pick(parts, "year")}`;
}

/** Unix seconds in ET: `Sun Oct 11, 8:00 PM ET`; with `withYear`, `Fri Oct 9, 2026 10:30 AM ET`. */
export function formatEtDateTime(unix: number | bigint, withYear = false): string {
  const parts = etParts.formatToParts(new Date(Number(unix) * 1000));
  const day = `${pick(parts, "weekday")} ${pick(parts, "month")} ${pick(parts, "day")}`;
  const time = `${pick(parts, "hour")}:${pick(parts, "minute")} ${pick(parts, "dayPeriod")} ET`;
  return withYear ? `${day}, ${pick(parts, "year")} ${time}` : `${day}, ${time}`;
}

/** Short badge text for a demo market row: `DEMO · sim Fri Oct 9, 2026`. */
export function demoBadgeText(tradingDate: number, registry: DemoRegistry): string {
  const session = findDemoSession(registry, tradingDate);
  return session === undefined
    ? "DEMO · not a real market day"
    : `DEMO · simulates ${formatCalendarDate(session.asOf)}`;
}

export type DemoBannerLine = { readonly tradingDate: number; readonly text: string };

/**
 * One banner line per demo trading date that still has an unsettled market (open, or closed and
 * waiting for settlement). The close time is the market's on-chain `close_ts` (the soonest
 * still ahead, else the latest past one), never the registry's copy.
 */
export function demoBannerLines(
  markets: readonly MarketRow[],
  registry: DemoRegistry,
  nowSecs: number,
): DemoBannerLine[] {
  const byDate = new Map<number, MarketRow[]>();
  for (const market of markets) {
    if (market.settled || !isDemoMarket(market)) continue;
    byDate.set(market.tradingDate, [...(byDate.get(market.tradingDate) ?? []), market]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tradingDate, rows]) => {
      const closes = rows.map((row) => Number(row.closeTs)).sort((a, b) => a - b);
      const ahead = closes.find((close) => close > nowSecs);
      const closeTs = ahead ?? closes[closes.length - 1] ?? 0;
      const verb = ahead === undefined ? "trading closed" : "trading closes";
      const session = findDemoSession(registry, tradingDate);
      const lead =
        session === undefined
          ? `DEMO · not a real market day (${formatCalendarDate(tradingDate)})`
          : `DEMO SESSION · simulates ${formatCalendarDate(session.asOf)}`;
      return {
        tradingDate,
        text: `${lead} · ${verb} ${formatEtDateTime(closeTs)} · devnet, no real funds`,
      };
    });
}
