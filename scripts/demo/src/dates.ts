/**
 * Dates and times of a demo session. All ET conversions go through luxon's `America/New_York`
 * zone (never a hardcoded offset); trading days come from the shared NYSE calendar.
 */
import {
  ET_ZONE,
  isDemoTradingDate,
  isTradingDay,
  previousTradingDay,
  tradingDateET,
  type IsoDate,
} from "@meridian/client";
import { isoDateSchema } from "automation";
import { DateTime } from "luxon";

/** A demo close must be at least this far in the future when the markets are created. */
export const MIN_CLOSE_LEAD_SECS = 300;
/** The default trading date is searched this many days ahead at most. */
export const MAX_DATE_SEARCH_DAYS = 31;

/** Validates `YYYY-MM-DD`; the error names the parameter. */
export function parseIsoDate(text: string, name: string): IsoDate {
  const result = isoDateSchema.safeParse(text.trim());
  if (!result.success) {
    throw new Error(`${name} must be a real date as YYYY-MM-DD, got ${JSON.stringify(text)}`);
  }
  return result.data;
}

/** `2026-10-11` as the on-chain `20261011`. */
export function yyyymmdd(date: IsoDate): number {
  return Number(date.replaceAll("-", ""));
}

/**
 * AS_OF: the real NYSE session being simulated. Must be a trading day; returns it with the
 * session before it, whose close is the strike basis (exactly as the morning job of AS_OF).
 */
export function asOfSession(asOf: IsoDate): { asOf: IsoDate; prevDate: IsoDate } {
  if (!isTradingDay(asOf)) {
    throw new Error(`AS_OF ${asOf} is not an NYSE trading day; name the real session to simulate`);
  }
  return { asOf, prevDate: previousTradingDay(asOf) };
}

/**
 * Refuses a real NYSE trading day (or a weekday the calendar cannot vouch for): demo markets
 * live only on weekends and NYSE holidays, where the automation never creates real markets.
 */
export function assertDemoTradingDate(date: IsoDate): IsoDate {
  if (!isDemoTradingDate(date)) {
    throw new Error(
      `TRADING_DATE ${date} is an NYSE trading day (or outside the calendar); demo markets ` +
        "only go on weekends and NYSE holidays",
    );
  }
  return date;
}

/**
 * The demo trading date: the requested one (refused if it is a trading day), else the first
 * non-trading ET date ≥ today that `isFree` accepts (a date already holding conflicting
 * markets is skipped).
 */
export async function selectDemoTradingDate(params: {
  readonly requested?: IsoDate | undefined;
  readonly now: Date;
  readonly isFree: (date: IsoDate) => Promise<boolean>;
}): Promise<IsoDate> {
  if (params.requested !== undefined) {
    return assertDemoTradingDate(params.requested);
  }
  let day = DateTime.fromISO(tradingDateET(params.now), { zone: ET_ZONE });
  for (let i = 0; i <= MAX_DATE_SEARCH_DAYS; i += 1, day = day.plus({ days: 1 })) {
    const iso = day.toISODate();
    if (iso !== null && isDemoTradingDate(iso) && (await params.isFree(iso))) {
      return iso;
    }
  }
  throw new Error(
    `no free non-trading day in the next ${String(MAX_DATE_SEARCH_DAYS)} days; pass TRADING_DATE`,
  );
}

const CLOSE_FORMATS = ["yyyy-MM-dd HH:mm", "yyyy-MM-dd'T'HH:mm"] as const;

/**
 * CLOSE (`YYYY-MM-DD HH:mm`, ET wall clock) as unix seconds. Refuses a time that does not exist
 * (spring-forward gap) or exists twice (fall-back hour), and one less than
 * MIN_CLOSE_LEAD_SECS from `now`.
 */
export function parseCloseEt(text: string, now: Date): number {
  const trimmed = text.trim();
  const parsed = CLOSE_FORMATS.map((format) =>
    DateTime.fromFormat(trimmed, format, { zone: ET_ZONE }),
  ).find((dt) => dt.isValid);
  if (parsed === undefined) {
    throw new Error(`CLOSE must be "YYYY-MM-DD HH:mm" (ET), got ${JSON.stringify(text)}`);
  }
  if (parsed.toFormat("yyyy-MM-dd HH:mm") !== trimmed.replace("T", " ")) {
    throw new Error(`CLOSE ${trimmed} does not exist in America/New_York (DST gap)`);
  }
  if (parsed.getPossibleOffsets().length > 1) {
    throw new Error(
      `CLOSE ${trimmed} is ambiguous in America/New_York (the DST fall-back hour); pick another time`,
    );
  }
  const closeTs = parsed.toUnixInteger();
  const nowSecs = Math.floor(now.getTime() / 1000);
  if (closeTs < nowSecs + MIN_CLOSE_LEAD_SECS) {
    throw new Error(
      `CLOSE ${formatEt(closeTs)} must be at least ${String(MIN_CLOSE_LEAD_SECS / 60)} minutes in the future`,
    );
  }
  return closeTs;
}

/** `Sun Oct 11 2026 8:00 PM ET` for unix seconds. */
export function formatEt(unixSecs: number): string {
  return `${DateTime.fromSeconds(unixSecs, { zone: ET_ZONE, locale: "en-US" }).toFormat("ccc LLL d yyyy h:mm a")} ET`;
}
