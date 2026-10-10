import { type PrevCloseResult } from "automation";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import {
  centsToDecimal,
  type ClosesTable,
  createCloseResolver,
  parseClosesJson,
  quoteJsonNumbers,
  serializeCloses,
} from "./closes";

// The shape the operator's Pyth Pro export uses (ticker → ET date → decimal close).
const PYTH = `{"AAPL": {"2026-10-07": 336.54995, "2026-10-08": 340.57993, "2026-10-09": 336.05506},
 "META": {"2026-10-08": 719.45174, "2026-10-09": 717.795}, "MSFT": {"2026-10-09": 534.99}}`;

describe("parseClosesJson", () => {
  it("reads the Pyth export shape and rounds to cents half up", () => {
    expect(parseClosesJson(PYTH, "f")).toEqual({
      AAPL: { "2026-10-07": 33_655, "2026-10-08": 34_058, "2026-10-09": 33_606 },
      META: { "2026-10-08": 71_945, "2026-10-09": 71_780 },
      MSFT: { "2026-10-09": 53_499 },
    });
  });

  it("reads closes from their source text, not through a float", () => {
    // 1.005 as a double is 1.00499999999999989...; the text rounds half up to 101 cents.
    expect(parseClosesJson('{"AAPL": {"2026-10-09": 1.005}}', "f")).toEqual({
      AAPL: { "2026-10-09": 101 },
    });
    // Strings are accepted too (the cache writes them).
    expect(parseClosesJson('{"AAPL": {"2026-10-09": "230.125"}}', "f")).toEqual({
      AAPL: { "2026-10-09": 23_013 },
    });
  });

  it("refuses bad files with the label in the message", () => {
    expect(() => parseClosesJson("{", "CLOSES_JSON")).toThrow(/CLOSES_JSON: not valid JSON/);
    expect(() => parseClosesJson('{"aapl": {"2026-10-09": 1}}', "CLOSES_JSON")).toThrow(
      /CLOSES_JSON/,
    );
    expect(() => parseClosesJson('{"AAPL": {"2026-13-09": 1}}', "f")).toThrow(/expected/);
    expect(() => parseClosesJson('{"AAPL": {"2026-10-09": true}}', "f")).toThrow(/expected/);
    expect(() => parseClosesJson('{"AAPL": {"2026-10-09": -1.5}}', "f")).toThrow(
      /positive decimal/,
    );
    expect(() => parseClosesJson('{"AAPL": {"2026-10-09": 1e3}}', "f")).toThrow(/positive decimal/);
    expect(() => parseClosesJson('{"AAPL": {"2026-10-09": 0}}', "f")).toThrow(/positive decimal/);
  });

  it("leaves numbers inside strings alone, escapes included", () => {
    expect(quoteJsonNumbers('{"a\\"1": [1, 2.5], "b": "x 3"}')).toBe(
      '{"a\\"1": ["1", "2.5"], "b": "x 3"}',
    );
  });

  it("matches exact integer math for any price with up to 5 decimals (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 500n, max: 10n ** 12n }), (micros) => {
        // micros = price × 10^5; text has exactly 5 decimals.
        const text = `${(micros / 100_000n).toString()}.${(micros % 100_000n).toString().padStart(5, "0")}`;
        const expected = (micros + 500n) / 1_000n; // half up to cents
        const parsed = parseClosesJson(`{"AAPL": {"2026-10-09": ${text}}}`, "f");
        expect(parsed.AAPL?.["2026-10-09"]).toBe(Number(expected));
      }),
      { examples: [[1_000n], [34_057_993n], [33_605_506n]] },
    );
  });
});

describe("serializeCloses", () => {
  it("round-trips through the file format exactly (property)", () => {
    const table = fc.dictionary(
      fc.constantFrom("AAPL", "MSFT", "NVDA"),
      fc.dictionary(
        fc.constantFrom("2026-10-08", "2026-10-09"),
        fc.integer({ min: 1, max: 10 ** 9 }),
      ),
    );
    fc.assert(
      fc.property(table, (t) => {
        expect(parseClosesJson(serializeCloses(t), "f")).toEqual(t);
      }),
    );
  });

  it("writes exact dollar strings", () => {
    expect(centsToDecimal(34_058)).toBe("340.58");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(serializeCloses({ B: { "2026-10-09": 100 }, A: { "2026-10-09": 1 } })).toBe(
      '{\n  "A": {\n    "2026-10-09": "0.01"\n  },\n  "B": {\n    "2026-10-09": "1.00"\n  }\n}\n',
    );
  });
});

function okClose(cents: number): PrevCloseResult {
  return {
    ok: true,
    value: {
      ticker: "AAPL",
      date: "2026-10-09",
      closeCents: cents,
      spreadBps: 0,
      sources: [
        { source: "tiingo", date: "2026-10-09", closeCents: cents },
        { source: "twelvedata", date: "2026-10-09", closeCents: cents },
      ],
    },
  };
}

describe("createCloseResolver", () => {
  it("uses CLOSES_JSON, then the cache, and never calls the APIs when a file is given", async () => {
    const fetchClose = vi.fn(() => Promise.resolve(okClose(1)));
    const resolve = createCloseResolver({
      file: { AAPL: { "2026-10-09": 33_606 } },
      cache: { MSFT: { "2026-10-09": 53_499 } },
      fetchClose,
    });
    await expect(resolve("AAPL", "2026-10-09")).resolves.toEqual({
      ok: true,
      cents: 33_606,
      source: "file",
    });
    await expect(resolve("MSFT", "2026-10-09")).resolves.toMatchObject({ source: "cache" });
    await expect(resolve("NVDA", "2026-10-09")).resolves.toEqual({
      ok: false,
      reason: "no NVDA close for 2026-10-09 in CLOSES_JSON",
    });
    expect(fetchClose).not.toHaveBeenCalled();
  });

  it("fetches through prevCloses on a cache miss and caches the result", async () => {
    const cache: ClosesTable = {};
    const onCached = vi.fn();
    const fetchClose = vi.fn(() => Promise.resolve(okClose(23_000)));
    const resolve = createCloseResolver({ cache, fetchClose, onCached });
    await expect(resolve("AAPL", "2026-10-09")).resolves.toEqual({
      ok: true,
      cents: 23_000,
      source: "api",
    });
    expect(cache).toEqual({ AAPL: { "2026-10-09": 23_000 } });
    expect(onCached).toHaveBeenCalledTimes(1);
    await expect(resolve("AAPL", "2026-10-09")).resolves.toMatchObject({ source: "cache" });
    expect(fetchClose).toHaveBeenCalledTimes(1);
  });

  it("reports an API failure and a missing key setup", async () => {
    const failing = createCloseResolver({
      cache: {},
      fetchClose: () =>
        Promise.resolve({
          ok: false,
          error: {
            kind: "source_unavailable",
            ticker: "AAPL",
            date: "2026-10-09",
            message: "HTTP 429",
          },
        }),
    });
    await expect(failing("AAPL", "2026-10-09")).resolves.toEqual({
      ok: false,
      reason: "AAPL 2026-10-09: source_unavailable: HTTP 429",
    });
    const keyless = createCloseResolver({ cache: {} });
    const result = await keyless("AAPL", "2026-10-09");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/set CLOSES_JSON, or TIINGO_API_KEY/);
  });
});
