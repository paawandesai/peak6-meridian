/**
 * Read-only replay of a past real session (`?replay=2026-10-09T10:30`, ET wall time).
 *
 * What the chain can reconstruct, and so what replay shows: the session's markets (ticker,
 * strike, trading date, `close_ts`), each market's state at the chosen instant (from `close_ts`
 * and `settled_at`), and the final settlement (outcome, settle price). What it cannot: the order
 * book or any price at the chosen instant. The program keeps only the current book, and the app
 * stores no intraday history, so replay never shows a book or price as if it were historical.
 *
 * ET wall time → unix seconds uses `Intl.DateTimeFormat` with `America/New_York`; no offsets.
 */
import { isTradingDay, previousTradingDay, tradingDateET } from "@meridian/client";
import { z } from "zod";

import { formatEtDateTime, isoFromYyyymmdd, isValidYyyymmdd } from "./demo-session";
import { sessionCloseTs } from "./time";
import type { MarketRow } from "./markets";

const ZONE = "America/New_York";
export const REPLAY_PARAM = "replay";

/** `YYYY-MM-DDTHH:mm` exactly (what `<input type="datetime-local">` submits). */
export const replayParamSchema = z
  .string()
  .regex(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/, {
    message: "use the form YYYY-MM-DDTHH:mm, for example 2026-10-09T10:30",
  })
  .transform((value) => {
    const [date = "", time = ""] = value.split("T");
    const [hour = 0, minute = 0] = time.split(":").map(Number);
    return { tradingDate: Number(date.replaceAll("-", "")), hour, minute };
  })
  .refine((value) => isValidYyyymmdd(value.tradingDate), { message: "that date does not exist" })
  .refine((value) => value.hour <= 23 && value.minute <= 59, {
    message: "that time does not exist",
  });

export type ReplayState =
  | { readonly kind: "live" }
  | { readonly kind: "invalid"; readonly raw: string; readonly reason: string }
  | {
      readonly kind: "replay";
      readonly raw: string;
      /** The replayed session's on-chain `trading_date`. */
      readonly tradingDate: number;
      /** The chosen instant, unix seconds. */
      readonly atSecs: number;
    };

const offsetParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** ET's offset from UTC at an instant, in seconds (negative: ET is behind UTC). */
function etOffsetSecs(unixSecs: number): number {
  const parts = offsetParts.formatToParts(new Date(unixSecs * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round(asUtc / 1000) - unixSecs;
}

/** The unix seconds of an ET wall-clock time on a `YYYYMMDD` date (DST-correct). */
export function etWallTimeToUnix(tradingDate: number, hour: number, minute: number): number {
  const year = Math.floor(tradingDate / 10_000);
  const month = Math.floor(tradingDate / 100) % 100;
  const day = tradingDate % 100;
  const naive = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  // Two passes settle the offset on both sides of a DST change.
  const first = naive - etOffsetSecs(naive);
  return naive - etOffsetSecs(first);
}

/**
 * Parses `?replay=`. Missing → live. Anything else must be a past instant during a real NYSE
 * session (09:30 ET to that day's close), or it is `invalid` and the app stays live with a
 * visible notice.
 */
export function parseReplayParam(raw: string | null, nowSecs: number): ReplayState {
  if (raw === null || raw.trim() === "") return { kind: "live" };
  const parsed = replayParamSchema.safeParse(raw.trim());
  if (!parsed.success) {
    return { kind: "invalid", raw, reason: parsed.error.issues[0]?.message ?? "invalid replay" };
  }
  const { tradingDate, hour, minute } = parsed.data;
  let tradingDay: boolean;
  try {
    tradingDay = isTradingDay(isoFromYyyymmdd(tradingDate));
  } catch {
    return { kind: "invalid", raw, reason: "that date is outside the supported NYSE calendar" };
  }
  if (!tradingDay) {
    return { kind: "invalid", raw, reason: "NYSE was closed that day, so there is no session" };
  }
  const atSecs = etWallTimeToUnix(tradingDate, hour, minute);
  const open = etWallTimeToUnix(tradingDate, 9, 30);
  const close = sessionCloseTs(tradingDate);
  if (close === null || atSecs < open || atSecs > close) {
    return { kind: "invalid", raw, reason: "pick a time between 9:30 AM ET and that day's close" };
  }
  if (atSecs >= nowSecs) {
    return { kind: "invalid", raw, reason: "replay only shows past sessions" };
  }
  return { kind: "replay", raw, tradingDate, atSecs };
}

/** `REPLAY · Fri Oct 9, 2026 10:30 AM ET · read-only`. */
export function replayBannerText(atSecs: number): string {
  return `REPLAY · ${formatEtDateTime(atSecs, true)} · read-only`;
}

/** The notice shown when `?replay=` is present but unusable. */
export function replayInvalidText(state: {
  readonly raw: string;
  readonly reason: string;
}): string {
  return `Replay link ignored (${state.reason}). Showing live markets.`;
}

/**
 * A market as it stood at `atSecs`: settled only if settlement had happened by then. Everything
 * else on the row is immutable on-chain (strike, date, close), so it is exact.
 */
export function marketAsOf(market: MarketRow, atSecs: number): MarketRow {
  const settledThen = market.settled && market.settledAt > 0n && Number(market.settledAt) <= atSecs;
  return settledThen
    ? market
    : { ...market, settled: false, outcome: "None", settlePriceScaled: 0n, settledAt: 0n };
}

/** The `datetime-local` value for an instant, in ET (`2026-10-09T10:30`). */
export function replayParamFor(atSecs: number): string {
  const parts = offsetParts.formatToParts(new Date(atSecs * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** The control's starting value: the previous NYSE session at 10:30 AM ET. */
export function defaultReplayParam(nowSecs: number): string {
  try {
    return `${previousTradingDay(tradingDateET(new Date(nowSecs * 1000)))}T10:30`;
  } catch {
    return replayParamFor(nowSecs - 24 * 3600);
  }
}
