/**
 * NYSE trading calendar (FR-15, domain.md § Market lifecycle and time rules).
 *
 * Dates are ET calendar dates as ISO strings (`YYYY-MM-DD`). Wall-clock times are converted with
 * the IANA `America/New_York` zone via luxon, so EST/EDT is never hardcoded.
 */
import { DateTime } from "luxon";

export const ET_ZONE = "America/New_York";

/** An ET calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

/**
 * Years the holiday tables cover. Each year was checked against nyse.com (domain.md requires this
 * before adding a year); dates outside these years are rejected rather than guessed.
 */
export const SUPPORTED_YEARS: readonly number[] = [2026];

/** Full-day NYSE closures. 2026 checked against nyse.com/markets/hours-calendars. */
const HOLIDAYS: ReadonlySet<IsoDate> = new Set([
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King, Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
]);

/** Early closes at 13:00 ET. */
const EARLY_CLOSES: ReadonlySet<IsoDate> = new Set([
  "2026-11-27", // Day after Thanksgiving
  "2026-12-24", // Christmas Eve
]);

const REGULAR_CLOSE_HOUR_ET = 16;
const EARLY_CLOSE_HOUR_ET = 13;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Close of a trading day. */
export interface CloseTime {
  /** ET wall-clock hour of the close: 16, or 13 on early-close days. */
  readonly hourET: 16 | 13;
  readonly minuteET: 0;
  /** `close_ts`: the close as unix seconds. */
  readonly closeTs: number;
}

/** Whether NYSE holds a regular session on the ET date. */
export function isTradingDay(date: IsoDate): boolean {
  const day = parseDate(date);
  const isWeekend = day.weekday === 6 || day.weekday === 7;
  return !isWeekend && !HOLIDAYS.has(date);
}

/**
 * Close of the session on the ET date: 16:00 ET, or 13:00 ET on early-close days.
 *
 * @throws RangeError if the date is not a trading day or outside SUPPORTED_YEARS.
 */
export function closeTimeET(date: IsoDate): CloseTime {
  if (!isTradingDay(date)) {
    throw new RangeError(`closeTimeET: ${date} is not an NYSE trading day`);
  }
  const hourET = EARLY_CLOSES.has(date) ? EARLY_CLOSE_HOUR_ET : REGULAR_CLOSE_HOUR_ET;
  const close = parseDate(date).set({ hour: hourET, minute: 0, second: 0, millisecond: 0 });
  return { hourET, minuteET: 0, closeTs: close.toUnixInteger() };
}

/** The ET calendar date of an instant. */
export function tradingDateET(instant: Date): IsoDate {
  const et = DateTime.fromJSDate(instant, { zone: ET_ZONE });
  const iso = et.isValid ? et.toISODate() : null;
  if (iso === null) {
    throw new RangeError(`tradingDateET: invalid instant ${String(instant)}`);
  }
  return iso;
}

/**
 * The last trading day strictly before the ET date (whose close feeds that date's strikes).
 *
 * @throws RangeError if the search leaves SUPPORTED_YEARS.
 */
export function previousTradingDay(date: IsoDate): IsoDate {
  let day = parseDate(date);
  for (;;) {
    day = day.minus({ days: 1 });
    const iso = day.toISODate();
    if (isTradingDay(iso)) {
      return iso;
    }
  }
}

/**
 * The next trading day strictly after the ET date (P0-1 weekend header).
 *
 * @throws RangeError if the search leaves SUPPORTED_YEARS.
 */
export function nextTradingDay(date: IsoDate): IsoDate {
  let day = parseDate(date);
  for (;;) {
    day = day.plus({ days: 1 });
    const iso = day.toISODate();
    if (isTradingDay(iso)) {
      return iso;
    }
  }
}

/** Parses an ISO date at ET midnight; rejects malformed dates and unsupported years. */
function parseDate(date: IsoDate): DateTime<true> {
  const day = ISO_DATE.test(date) ? DateTime.fromISO(date, { zone: ET_ZONE }) : null;
  if (day === null || !day.isValid || day.toISODate() !== date) {
    throw new RangeError(
      `calendar: expected an ET date as YYYY-MM-DD, got ${JSON.stringify(date)}`,
    );
  }
  if (!SUPPORTED_YEARS.includes(day.year)) {
    throw new RangeError(
      `calendar: ${date} is outside the NYSE holiday tables (${SUPPORTED_YEARS.join(", ")}); ` +
        "check nyse.com and add the year to domain.md and calendar.ts",
    );
  }
  return day;
}
