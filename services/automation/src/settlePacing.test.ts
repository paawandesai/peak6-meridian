import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { closeTimeET, isTradingDay } from "./calendar";
import {
  attemptCost,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffUntil,
  DEFAULT_MAX_API_CALLS_PER_RUN,
  parseRetryAfterMs,
  rateLimitBackoffMs,
  sessionGate,
} from "./settlePacing";

const etMs = (iso: string): number => Date.parse(iso);

describe("rateLimitBackoffMs", () => {
  it("doubles from 2 minutes and caps at 60", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(rateLimitBackoffMs)).toEqual(
      [2, 4, 8, 16, 32, 60, 60, 60].map((minutes) => minutes * 60_000),
    );
    expect(rateLimitBackoffMs(0)).toBe(0);
    expect(rateLimitBackoffMs(-3)).toBe(0);
    expect(rateLimitBackoffMs(1.5)).toBe(0);
  });

  it("is non-decreasing and within [base, cap] for every strike count (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (strikes) => {
        const wait = rateLimitBackoffMs(strikes);
        expect(wait).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
        expect(wait).toBeLessThanOrEqual(BACKOFF_CAP_MS);
        expect(rateLimitBackoffMs(strikes + 1)).toBeGreaterThanOrEqual(wait);
      }),
    );
  });
});

describe("parseRetryAfterMs", () => {
  const now = etMs("2026-10-10T20:00:00Z");

  it("reads delta-seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("120", now)).toBe(120_000);
    expect(parseRetryAfterMs(" 0 ", now)).toBe(0);
    expect(parseRetryAfterMs("Sat, 10 Oct 2026 20:05:00 GMT", now)).toBe(300_000);
    expect(parseRetryAfterMs("Sat, 10 Oct 2026 19:00:00 GMT", now)).toBe(0); // already past
  });

  it("returns null for anything else", () => {
    for (const value of [null, undefined, "", "-5", "1.5", "soon", "2026-10-10T21:00:00Z"]) {
      expect(parseRetryAfterMs(value, now)).toBeNull();
    }
  });

  it("never returns a negative or non-finite wait (property)", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 4_102_444_800_000 }), (value, at) => {
        const wait = parseRetryAfterMs(value, at);
        if (wait !== null) {
          expect(Number.isFinite(wait)).toBe(true);
          expect(wait).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });
});

describe("backoffUntil", () => {
  it("takes the larger of the backoff and Retry-After, capped at 60 minutes", () => {
    expect(backoffUntil(0, 1, null)).toBe(2 * 60_000);
    expect(backoffUntil(0, 1, 10 * 60_000)).toBe(10 * 60_000);
    expect(backoffUntil(0, 3, 60_000)).toBe(8 * 60_000);
    expect(backoffUntil(0, 1, 24 * 3_600_000)).toBe(BACKOFF_CAP_MS);
  });

  it("always waits at least the backoff and Retry-After (up to the cap), never more (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.integer({ min: 1, max: 100 }),
        fc.option(fc.integer({ min: 0, max: 100_000_000 }), { nil: null }),
        (now, strikes, retryAfter) => {
          const wait = backoffUntil(now, strikes, retryAfter) - now;
          expect(wait).toBeGreaterThanOrEqual(rateLimitBackoffMs(strikes));
          expect(wait).toBeGreaterThanOrEqual(Math.min(retryAfter ?? 0, BACKOFF_CAP_MS));
          expect(wait).toBeLessThanOrEqual(BACKOFF_CAP_MS);
        },
      ),
    );
  });
});

describe("attemptCost and the default cap", () => {
  it("reserves both checks, plus both oracle fetches on Switchboard", () => {
    expect(attemptCost("local")).toBe(2);
    expect(attemptCost("switchboard")).toBe(4);
    // The default fits Twelve Data's free tier: at most cap / 2 Twelve Data requests per minute.
    expect(DEFAULT_MAX_API_CALLS_PER_RUN / 2).toBeLessThanOrEqual(8);
  });
});

describe("sessionGate", () => {
  const DELAY = 300;

  it("skips weekends and holidays, whatever the hour", () => {
    expect(sessionGate("2026-10-10", etMs("2026-10-12T12:00:00Z"), DELAY)).toMatchObject({
      ok: false,
      reason: "not_a_trading_day",
    });
    expect(sessionGate("2026-11-26", etMs("2026-11-30T12:00:00Z"), DELAY)).toMatchObject({
      ok: false,
      reason: "not_a_trading_day",
    });
  });

  it("skips a session until its official close plus the delay (EDT: 16:05 ET = 20:05Z)", () => {
    expect(sessionGate("2026-10-12", etMs("2026-10-10T20:00:00Z"), DELAY)).toMatchObject({
      ok: false,
      reason: "session_not_closed",
    });
    expect(sessionGate("2026-10-09", etMs("2026-10-09T20:04:59Z"), DELAY).ok).toBe(false);
    expect(sessionGate("2026-10-09", etMs("2026-10-09T20:05:00Z"), DELAY).ok).toBe(true);
    // Settle-now (delay 0): from the close itself.
    expect(sessionGate("2026-10-09", etMs("2026-10-09T20:00:00Z"), 0).ok).toBe(true);
  });

  it("follows the real time zone (EST after 1 Nov: 16:05 ET = 21:05Z) and early closes", () => {
    expect(sessionGate("2026-11-02", etMs("2026-11-02T20:05:00Z"), DELAY).ok).toBe(false);
    expect(sessionGate("2026-11-02", etMs("2026-11-02T21:05:00Z"), DELAY).ok).toBe(true);
    // Day after Thanksgiving: early close 13:00 ET (18:00Z), settleable from 13:05 ET.
    expect(sessionGate("2026-11-27", etMs("2026-11-27T18:04:59Z"), DELAY).ok).toBe(false);
    expect(sessionGate("2026-11-27", etMs("2026-11-27T18:05:00Z"), DELAY).ok).toBe(true);
  });

  it("refuses dates outside the checked holiday tables rather than guessing", () => {
    expect(sessionGate("2027-01-04", etMs("2027-01-05T00:00:00Z"), DELAY)).toMatchObject({
      ok: false,
      reason: "outside_calendar",
    });
  });

  it("is ok exactly when the date is a trading day whose close + delay has passed (property)", () => {
    const start = etMs("2026-01-01T05:00:00Z");
    const end = etMs("2027-01-01T05:00:00Z");
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 364 }),
        fc.integer({ min: start, max: end - 1 }),
        fc.integer({ min: 0, max: 3_600 }),
        (dayIndex, now, delay) => {
          const date = new Date(start + dayIndex * 86_400_000).toISOString().slice(0, 10);
          const gate = sessionGate(date, now, delay);
          const expected = isTradingDay(date) && now >= (closeTimeET(date).closeTs + delay) * 1_000;
          expect(gate.ok).toBe(expected);
        },
      ),
    );
  });
});
