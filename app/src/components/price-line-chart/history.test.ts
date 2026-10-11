import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  bucketStart,
  historyQuery,
  historyUrl,
  parseHistory,
  RANGE_SPEC,
  toCents,
} from "./history";

const NOW = 1_791_480_123;

describe("historyQuery / historyUrl", () => {
  it("asks for 5-minute candles over the last day, ending at the 5-minute bucket", () => {
    const q = historyQuery("NVDA", "1D", NOW);
    expect(q).toEqual({
      symbol: "Equity.US.NVDA/USD",
      resolution: "5",
      from: 1_791_480_000 - 86_400,
      to: 1_791_480_000,
    });
  });

  it("asks for hourly candles over the last week", () => {
    const q = historyQuery("AAPL", "1W", NOW);
    expect(q.resolution).toBe("60");
    expect(q.to - q.from).toBe(604_800);
    expect(RANGE_SPEC["1W"].words).toBe("last week");
  });

  it("builds the route URL with every parameter", () => {
    const url = historyUrl(historyQuery("TSLA", "1D", NOW));
    const params = new URL(url, "http://localhost").searchParams;
    expect(url.startsWith("/api/pyth-history?")).toBe(true);
    expect(params.get("symbol")).toBe("Equity.US.TSLA/USD");
    expect(params.get("resolution")).toBe("5");
    expect(params.get("to")).toBe("1791480000");
    expect(params.get("from")).toBe(String(1_791_480_000 - 86_400));
  });

  it("property: the bucket is a multiple of 300 within the last 300 s", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_000_000_000 }), (now) => {
        const b = bucketStart(now);
        expect(b % 300).toBe(0);
        expect(now - b).toBeGreaterThanOrEqual(0);
        expect(now - b).toBeLessThan(300);
      }),
    );
  });
});

describe("toCents", () => {
  it("rounds dollars to whole cents", () => {
    expect(toCents(181.42)).toBe(18_142);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(227.105)).toBe(22_711);
  });

  it("property: any whole-cent price survives the dollars round trip", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), (cents) => {
        expect(toCents(cents / 100)).toBe(cents);
      }),
    );
  });

  it("property: the result is an integer within half a cent of the input", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1_000_000, noNaN: true }), (dollars) => {
        const cents = toCents(dollars);
        expect(Number.isInteger(cents)).toBe(true);
        expect(Math.abs(cents - dollars * 100)).toBeLessThanOrEqual(0.5 + 1e-6);
      }),
    );
  });
});

describe("parseHistory", () => {
  it("returns points ascending by time with closes in cents", () => {
    const parsed = parseHistory({
      s: "ok",
      t: [300, 100, 200],
      o: [1, 1, 1],
      c: [181.42, 180.1, 180.995],
    });
    expect(parsed).toEqual({
      kind: "ok",
      points: [
        { timeSecs: 100, closeCents: 18_010 },
        { timeSecs: 200, closeCents: 18_100 },
        { timeSecs: 300, closeCents: 18_142 },
      ],
    });
  });

  it("keeps the last close for a repeated time", () => {
    const parsed = parseHistory({ s: "ok", t: [100, 100], c: [1, 2] });
    expect(parsed).toEqual({ kind: "ok", points: [{ timeSecs: 100, closeCents: 200 }] });
  });

  it("reads no_data, empty arrays, missing arrays and mismatched lengths as no data", () => {
    expect(parseHistory({ s: "no_data" })).toEqual({ kind: "no_data" });
    expect(parseHistory({ s: "ok", t: [], c: [] })).toEqual({ kind: "no_data" });
    expect(parseHistory({ s: "ok", t: [1] })).toEqual({ kind: "no_data" });
    expect(parseHistory({ s: "ok", c: [1] })).toEqual({ kind: "no_data" });
    expect(parseHistory({ s: "ok", t: [1, 2], c: [1] })).toEqual({ kind: "no_data" });
  });

  it("reads a schema failure or an upstream error as an error", () => {
    expect(parseHistory(null)).toEqual({ kind: "error" });
    expect(parseHistory("nope")).toEqual({ kind: "error" });
    expect(parseHistory({ s: "maybe" })).toEqual({ kind: "error" });
    expect(parseHistory({ s: "ok", t: ["1"], c: [1] })).toEqual({ kind: "error" });
    expect(parseHistory({ s: "error" })).toEqual({ kind: "error" });
  });

  it("property: ok output has strictly increasing integer times and integer cents", () => {
    const candles = fc.array(
      fc.record({
        t: fc.integer({ min: 0, max: 2_000_000_000 }),
        c: fc.integer({ min: 1, max: 10_000_000 }).map((cents) => cents / 100),
      }),
      { minLength: 1, maxLength: 60 },
    );
    fc.assert(
      fc.property(candles, (rows) => {
        const parsed = parseHistory({ s: "ok", t: rows.map((r) => r.t), c: rows.map((r) => r.c) });
        expect(parsed.kind).toBe("ok");
        if (parsed.kind !== "ok") return;
        expect(parsed.points.length).toBe(new Set(rows.map((r) => r.t)).size);
        parsed.points.forEach((p, i) => {
          expect(Number.isInteger(p.closeCents)).toBe(true);
          expect(Number.isInteger(p.timeSecs)).toBe(true);
          const prev = parsed.points[i - 1];
          if (prev !== undefined) expect(p.timeSecs).toBeGreaterThan(prev.timeSecs);
        });
        // Every point's close is the last close given for its time.
        const lastByTime = new Map(rows.map((r) => [r.t, toCents(r.c)]));
        parsed.points.forEach((p) => expect(p.closeCents).toBe(lastByTime.get(p.timeSecs)));
      }),
    );
  });

  it("property: arrays of different lengths never produce points", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { maxLength: 20 }),
        fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), { maxLength: 20 }),
        (t, c) => {
          fc.pre(t.length !== c.length);
          expect(parseHistory({ s: "ok", t, c })).toEqual({ kind: "no_data" });
        },
      ),
    );
  });
});
