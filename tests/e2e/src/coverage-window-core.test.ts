import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { BookQuotes } from "@meridian/client";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  collect,
  formatBps,
  isTwoSided,
  ratioBps,
  renderLogEntry,
  type Sample,
  sampleCoverageBps,
  type StrikeSample,
  summarize,
  TARGET_BPS,
} from "./coverage-window-core";

const FIXTURE = fileURLToPath(
  new URL("../../fixtures/friday/coverage_stream.json", import.meta.url),
);
/** A recorded 30-minute stream: 61 samples, 4 strikes; META $720 is one-sided in samples 10–13. */
const recorded = JSON.parse(readFileSync(FIXTURE, "utf8")) as Sample[];

const quotes = (bid: number | null, ask: number | null): BookQuotes => ({
  yesBid: bid,
  yesAsk: ask,
  yesMid: bid !== null && ask !== null ? Math.floor((bid + ask) / 2) : null,
  noPrice: null,
});
const strike = (i: number, q: BookQuotes | null): StrikeSample => ({
  market: `M${i}`,
  label: `T $${i}`,
  quotes: q,
});

describe("two-sided and coverage arithmetic", () => {
  it("needs both a best bid and a best ask", () => {
    expect(isTwoSided(quotes(58, 61))).toBe(true);
    expect(isTwoSided(quotes(58, null))).toBe(false);
    expect(isTwoSided(quotes(null, 61))).toBe(false);
    expect(isTwoSided(quotes(null, null))).toBe(false);
    expect(isTwoSided(null)).toBe(false); // an unreadable book is not a quote
  });

  it("ratioBps floors in integers and never invents 100% for nothing", () => {
    expect(ratioBps(240, 244)).toBe(9836);
    expect(ratioBps(1, 3)).toBe(3333);
    expect(ratioBps(0, 5)).toBe(0);
    expect(ratioBps(5, 5)).toBe(10_000);
    expect(ratioBps(0, 0)).toBeNull();
  });

  it("formats basis points as a percentage", () => {
    expect(formatBps(9836)).toBe("98.36%");
    expect(formatBps(10_000)).toBe("100.00%");
    expect(formatBps(5)).toBe("0.05%");
    expect(formatBps(TARGET_BPS)).toBe("95.00%");
  });

  it("a sample's coverage is the share of its open strikes that are two-sided", () => {
    const strikes = [strike(1, quotes(1, 2)), strike(2, quotes(1, null)), strike(3, null)];
    expect(sampleCoverageBps(strikes)).toBe(3333);
    expect(sampleCoverageBps([])).toBeNull();
  });

  it("property: coverage is between 0 and 100% and monotone in the two-sided count", () => {
    fc.assert(
      fc.property(fc.nat(500), fc.nat(500), (a, b) => {
        const [part, whole] = a <= b ? [a, b] : [b, a];
        const bps = ratioBps(part, whole);
        if (whole === 0) return bps === null;
        return bps !== null && bps >= 0 && bps <= 10_000;
      }),
    );
  });
});

describe("summarize a recorded sample stream (AC3)", () => {
  const summary = summarize(recorded);

  it("pools strike-samples: 240 of 244 two-sided is 98.36%, which passes", () => {
    expect(summary.samples).toBe(61);
    expect(summary.failedSamples).toBe(0);
    expect(summary.openStrikeSamples).toBe(244);
    expect(summary.twoSidedStrikeSamples).toBe(240);
    expect(summary.pooledBps).toBe(9836);
    expect(summary.minSampleBps).toBe(7500);
    expect(summary.passes).toBe(true);
    expect(summary.reasons).toEqual([]);
    expect(summary.endedAt).toBe((summary.startedAt ?? 0) + 30 * 60);
  });

  it("names the strike that fell short even when the window passes", () => {
    expect(summary.shortfalls.map((s) => [s.label, s.twoSided, s.samples, s.bps])).toEqual([
      ["META $720", 57, 61, 9344],
    ]);
    expect(summary.perStrike.map((s) => s.label)).toEqual([
      "META $660",
      "META $680",
      "META $700",
      "META $720",
    ]);
  });

  it("fails when a second strike is one-sided too: 5.7% of strike-samples missing", () => {
    const worse = recorded.map((sample, i) =>
      sample.ok && i >= 10 && i < 31
        ? {
            ...sample,
            strikes: sample.strikes.map((s, k) =>
              k === 2 ? { ...s, quotes: quotes(58, null) } : s,
            ),
          }
        : sample,
    );
    const result = summarize(worse);
    expect(result.twoSidedStrikeSamples).toBe(240 - 21);
    expect(result.pooledBps).toBe(8975);
    expect(result.passes).toBe(false);
    expect(result.reasons).toEqual(["pooled coverage 89.75% is below 95.00%"]);
    expect(result.shortfalls.map((s) => s.label)).toEqual(["META $700", "META $720"]);
  });

  it("failed reads are counted, not hidden, and over 10% they void the claim", () => {
    const failed: Sample = { ok: false, at: 5, error: "rpc timeout" };
    const some = summarize([...recorded, failed]);
    expect(some.failedSamples).toBe(1);
    expect(some.pooledBps).toBe(9836); // failed reads do not change the pooled figure
    expect(some.passes).toBe(true);
    const many = summarize([...recorded.slice(0, 9), ...Array.from({ length: 2 }, () => failed)]);
    expect(many.passes).toBe(false);
    expect(many.reasons[0]).toMatch(/2 of 11 reads failed/);
  });

  it("an empty window or one with no open strike never passes", () => {
    expect(summarize([]).passes).toBe(false);
    expect(summarize([]).reasons).toContain("no samples were taken");
    const none = summarize([{ ok: true, at: 1, strikes: [] }]);
    expect(none.pooledBps).toBeNull();
    expect(none.passes).toBe(false);
    expect(none.reasons).toContain("no open strike was ever sampled");
  });

  it("property: pooled coverage is Σ two-sided over Σ open, and passes follows the target", () => {
    const flag = fc.boolean();
    fc.assert(
      fc.property(
        fc.array(fc.array(flag, { maxLength: 6 }), { minLength: 1, maxLength: 20 }),
        (grid) => {
          const samples: Sample[] = grid.map((row, i) => ({
            ok: true,
            at: i,
            strikes: row.map((two, k) => strike(k, two ? quotes(1, 2) : quotes(1, null))),
          }));
          const result = summarize(samples);
          const open = grid.reduce((n, row) => n + row.length, 0);
          const two = grid.reduce((n, row) => n + row.filter(Boolean).length, 0);
          expect(result.openStrikeSamples).toBe(open);
          expect(result.twoSidedStrikeSamples).toBe(two);
          expect(result.pooledBps).toBe(ratioBps(two, open));
          expect(result.passes).toBe(open > 0 && (ratioBps(two, open) ?? 0) >= TARGET_BPS);
        },
      ),
    );
  });
});

describe("collect: the sampling schedule with an injected clock", () => {
  function clock(startSecs = 1_000) {
    let ms = startSecs * 1000;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => Math.floor(ms / 1000),
      sleep: (wait: number) => {
        sleeps.push(wait);
        ms += wait;
        return Promise.resolve();
      },
      advance: (secs: number) => {
        ms += secs * 1000;
      },
    };
  }

  it("30 min at 30 s is 61 samples on a fixed schedule", async () => {
    const c = clock();
    const samples = await collect({
      sample: () => Promise.resolve([strike(1, quotes(1, 2))]),
      ...c,
    });
    expect(samples).toHaveLength(61);
    expect(samples.map((s) => s.at)).toEqual(Array.from({ length: 61 }, (_, i) => 1_000 + 30 * i));
    expect(c.sleeps.every((ms) => ms === 30_000)).toBe(true);
    expect(c.sleeps).toHaveLength(60);
  });

  it("a slow read does not push later samples back, and an overrun skips a slot", async () => {
    const c = clock();
    let calls = 0;
    const samples = await collect({
      sample: () => {
        calls += 1;
        if (calls === 2) c.advance(65); // the second read takes 65 s: the slot due at +60 is skipped
        return Promise.resolve([strike(1, quotes(1, 2))]);
      },
      intervalSecs: 30,
      durationSecs: 120,
      ...c,
    });
    expect(samples.map((s) => s.at)).toEqual([1_000, 1_030, 1_095, 1_120]);
  });

  it("records a failed read as a failed sample and carries on", async () => {
    const c = clock();
    let calls = 0;
    const samples = await collect({
      sample: () => {
        calls += 1;
        return calls === 2
          ? Promise.reject(new Error("429 too many requests"))
          : Promise.resolve([]);
      },
      intervalSecs: 10,
      durationSecs: 30,
      ...c,
    });
    expect(samples).toHaveLength(4);
    expect(samples[1]).toEqual({ ok: false, at: 1_010, error: "429 too many requests" });
    expect(samples[2]?.ok).toBe(true);
  });

  it("reports progress and rejects non-whole intervals and durations", async () => {
    const c = clock();
    const seen: number[] = [];
    await collect({
      sample: () => Promise.resolve([]),
      intervalSecs: 5,
      durationSecs: 10,
      onSample: (s) => seen.push(s.at),
      ...c,
    });
    expect(seen).toEqual([1_000, 1_005, 1_010]);
    await expect(
      collect({ sample: () => Promise.resolve([]), intervalSecs: 0, ...c }),
    ).rejects.toThrow(/interval/);
    await expect(
      collect({ sample: () => Promise.resolve([]), durationSecs: 1.5, ...c }),
    ).rejects.toThrow(/duration/);
  });
});

describe("the docs/log.md entry", () => {
  const context = {
    who: "peak6-meridian-21",
    date: "2026-10-09",
    etWindow: "14:30:00–15:00:00",
    intervalSecs: 30,
  };

  it("states the verdict, the pooled figure and the strike below target", () => {
    const text = renderLogEntry(summarize(recorded), context);
    expect(text).toContain("### Book coverage window · 2026-10-09 · PASS");
    expect(text).toContain("61 samples, 0 failed reads");
    expect(text).toContain("**98.36%** (240 of 244 strike-samples; target 95.00%)");
    expect(text).toContain("worst single sample 75.00%");
    expect(text).toContain("META $720 93.44%");
  });

  it("says why a window fails", () => {
    const text = renderLogEntry(summarize([]), context);
    expect(text).toContain("· FAIL");
    expect(text).toContain("Pooled two-sided coverage: **n/a**");
    expect(text).toContain("Not passing: no samples were taken; no open strike was ever sampled.");
  });
});
