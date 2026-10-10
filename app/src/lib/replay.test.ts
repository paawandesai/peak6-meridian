import { isTradingDay } from "@meridian/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  defaultReplayParam,
  etWallTimeToUnix,
  marketAsOf,
  parseReplayParam,
  replayBannerText,
  replayInvalidText,
  replayParamFor,
  replayParamSchema,
} from "./replay";
import { market } from "@/test-utils";

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
/** A "now" well after every replay target below. */
const NOW = utc("2026-12-31T23:00:00Z");

describe("etWallTimeToUnix", () => {
  it("converts ET wall time in daylight time (EDT, UTC−4)", () => {
    expect(etWallTimeToUnix(20261009, 10, 30)).toBe(utc("2026-10-09T14:30:00Z"));
  });

  it("converts ET wall time in standard time (EST, UTC−5)", () => {
    expect(etWallTimeToUnix(20261214, 10, 30)).toBe(utc("2026-12-14T15:30:00Z"));
    expect(etWallTimeToUnix(20260105, 16, 0)).toBe(utc("2026-01-05T21:00:00Z"));
  });

  it("is correct on both DST change days", () => {
    expect(etWallTimeToUnix(20260309, 9, 30)).toBe(utc("2026-03-09T13:30:00Z")); // Mon after spring-forward
    expect(etWallTimeToUnix(20261102, 9, 30)).toBe(utc("2026-11-02T14:30:00Z")); // Mon after fall-back
    expect(etWallTimeToUnix(20261030, 9, 30)).toBe(utc("2026-10-30T13:30:00Z")); // Fri before
  });
});

describe("parseReplayParam", () => {
  it("is live with no parameter", () => {
    expect(parseReplayParam(null, NOW)).toEqual({ kind: "live" });
    expect(parseReplayParam("", NOW)).toEqual({ kind: "live" });
  });

  it("accepts a past instant inside a real session", () => {
    expect(parseReplayParam("2026-10-09T10:30", NOW)).toEqual({
      kind: "replay",
      raw: "2026-10-09T10:30",
      tradingDate: 20261009,
      atSecs: utc("2026-10-09T14:30:00Z"),
    });
  });

  it("accepts the open and the close exactly", () => {
    expect(parseReplayParam("2026-10-09T09:30", NOW).kind).toBe("replay");
    expect(parseReplayParam("2026-10-09T16:00", NOW).kind).toBe("replay");
    expect(parseReplayParam("2026-11-27T13:00", NOW).kind).toBe("replay"); // early close
  });

  const invalid: readonly (readonly [string, RegExp])[] = [
    ["2026-10-09", /YYYY-MM-DDTHH:mm/],
    ["10:30", /YYYY-MM-DDTHH:mm/],
    ["2026-10-09T10:30:00", /YYYY-MM-DDTHH:mm/],
    ["<script>", /YYYY-MM-DDTHH:mm/],
    ["2026-02-30T10:30", /date does not exist/],
    ["2026-10-09T25:00", /time does not exist/],
    ["2026-10-09T10:61", /time does not exist/],
    ["2026-10-10T10:30", /NYSE was closed/], // Saturday
    ["2026-11-26T10:30", /NYSE was closed/], // Thanksgiving
    ["2026-10-09T09:29", /between 9:30 AM ET/],
    ["2026-10-09T16:01", /between 9:30 AM ET/],
    ["2026-11-27T14:00", /between 9:30 AM ET/], // after the 13:00 early close
    ["2025-10-09T10:30", /supported NYSE calendar/],
  ];
  it.each(invalid)("rejects %s", (raw, reason) => {
    const state = parseReplayParam(raw, NOW);
    expect(state.kind).toBe("invalid");
    if (state.kind === "invalid") expect(state.reason).toMatch(reason);
  });

  it("rejects the future and the present (replay is past sessions only)", () => {
    const at = utc("2026-10-09T14:30:00Z");
    expect(parseReplayParam("2026-10-09T10:30", at).kind).toBe("invalid");
    expect(parseReplayParam("2026-10-09T10:30", at - 1).kind).toBe("invalid");
    expect(parseReplayParam("2026-10-09T10:30", at + 1).kind).toBe("replay");
  });

  it("never throws and is always one of live, invalid or replay", () => {
    fc.assert(
      fc.property(fc.option(fc.string()), (raw) => {
        expect(["live", "invalid", "replay"]).toContain(parseReplayParam(raw, NOW).kind);
      }),
    );
  });

  it("round-trips every in-session minute of every 2026 trading day", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 364 }),
        fc.integer({ min: 9 * 60 + 30, max: 13 * 60 }),
        (offset, minuteOfDay) => {
          const d = new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000);
          const date = d.toISOString().slice(0, 10);
          fc.pre(isTradingDay(date));
          const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
          const mm = String(minuteOfDay % 60).padStart(2, "0");
          const raw = `${date}T${hh}:${mm}`;
          const state = parseReplayParam(raw, NOW);
          expect(state.kind).toBe("replay");
          if (state.kind === "replay") expect(replayParamFor(state.atSecs)).toBe(raw);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("replayParamSchema", () => {
  it("is the zod boundary for the raw parameter", () => {
    expect(replayParamSchema.safeParse("2026-10-09T10:30").success).toBe(true);
    expect(replayParamSchema.safeParse(20261009).success).toBe(false);
  });
});

describe("replay text", () => {
  it("formats the banner in ET (EDT)", () => {
    expect(replayBannerText(utc("2026-10-09T14:30:00Z"))).toBe(
      "REPLAY · Fri Oct 9, 2026 10:30 AM ET · read-only",
    );
  });

  it("formats the banner in ET (EST)", () => {
    expect(replayBannerText(utc("2026-12-14T15:30:00Z"))).toBe(
      "REPLAY · Mon Dec 14, 2026 10:30 AM ET · read-only",
    );
  });

  it("explains an ignored link", () => {
    expect(replayInvalidText({ raw: "x", reason: "bad" })).toBe(
      "Replay link ignored (bad). Showing live markets.",
    );
  });

  it("defaults the control to the previous session at 10:30 AM ET", () => {
    expect(defaultReplayParam(utc("2026-10-10T16:00:00Z"))).toBe("2026-10-09T10:30"); // Sat → Fri
    expect(defaultReplayParam(utc("2026-10-13T16:00:00Z"))).toBe("2026-10-12T10:30"); // Tue → Mon
    expect(defaultReplayParam(utc("2031-06-11T16:00:00Z"))).toBe("2031-06-10T12:00"); // no calendar
  });
});

describe("marketAsOf", () => {
  const settled = market({
    settled: true,
    outcome: "Yes",
    closeTs: BigInt(utc("2026-10-09T20:00:00Z")),
    settledAt: BigInt(utc("2026-10-09T20:06:00Z")),
  });

  it("shows a later-settled market as unsettled at the replay time", () => {
    const then = marketAsOf(settled, utc("2026-10-09T14:30:00Z"));
    expect(then).toMatchObject({
      settled: false,
      outcome: "None",
      settlePriceScaled: 0n,
      settledAt: 0n,
    });
    expect(then.strikeCents).toBe(settled.strikeCents);
  });

  it("keeps the settlement once it had happened", () => {
    expect(marketAsOf(settled, utc("2026-10-09T20:07:00Z"))).toBe(settled);
  });
});
