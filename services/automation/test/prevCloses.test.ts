import { readFileSync } from "node:fs";

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TIMEOUT_MS,
  fetchPrevClose,
  meanHalfUp,
  withinSpread,
  type HttpGet,
  type HttpResponse,
  type PrevCloseResult,
} from "../src/prevCloses";

const FIXTURES = new URL("../../../tests/fixtures/dataapis/", import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");

const TIINGO_KEY = "test-tiingo-key";
const TWELVE_KEY = "test-twelvedata-key";
const DATE = "2026-10-05";

type Reply = HttpResponse | Error;
const reply = (status: number, body: string): HttpResponse => ({
  status,
  text: () => Promise.resolve(body),
});
const ok = (name: string): HttpResponse => reply(200, fixture(name));

/** Fake HTTP client: routes by host, never touches the network. */
function fakeHttp(tiingo: Reply, twelve: Reply): ReturnType<typeof vi.fn<HttpGet>> {
  return vi.fn<HttpGet>((url) => {
    const host = new URL(url).host;
    const r = host === "api.tiingo.com" ? tiingo : host === "api.twelvedata.com" ? twelve : null;
    if (r === null) {
      return Promise.reject(new Error(`unexpected host ${host}`));
    }
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  });
}

async function run(tiingo: Reply, twelve: Reply, ticker = "AAPL"): Promise<PrevCloseResult> {
  const http = fakeHttp(tiingo, twelve);
  return fetchPrevClose(
    { http, tiingoApiKey: TIINGO_KEY, twelveDataApiKey: TWELVE_KEY },
    ticker,
    DATE,
  );
}

function expectError(result: PrevCloseResult): Extract<PrevCloseResult, { ok: false }>["error"] {
  if (result.ok) {
    throw new Error(`expected an error, got ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

describe("fetchPrevClose (AC4, fixtures only)", () => {
  it("agree: returns the half-up mean of both closes", async () => {
    const result = await run(
      ok("tiingo_aapl_2026-10-05.json"),
      ok("twelvedata_aapl_2026-10-05_agree.json"),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        ticker: "AAPL",
        date: DATE,
        closeCents: 23_014, // (23,012 + 23,015) / 2 = 23,013.5 → 23,014
        spreadBps: 1,
        sources: [
          { source: "tiingo", date: DATE, closeCents: 23_012 },
          { source: "twelvedata", date: DATE, closeCents: 23_015 },
        ],
      },
    });
  });

  it("disagree: > 5 bps apart is an error naming both closes", async () => {
    const error = expectError(
      await run(ok("tiingo_aapl_2026-10-05.json"), ok("twelvedata_aapl_2026-10-05_disagree.json")),
    );
    expect(error).toMatchObject({ kind: "sources_disagree", ticker: "AAPL", date: DATE });
    expect(error.source).toBeUndefined();
    expect(error.message).toContain("23012");
    expect(error.message).toContain("23030");
  });

  it.each([
    [
      "tiingo HTTP 503",
      reply(503, "Service Unavailable"),
      ok("twelvedata_aapl_2026-10-05_agree.json"),
      "tiingo",
    ],
    [
      "tiingo network error",
      new Error("ECONNRESET"),
      ok("twelvedata_aapl_2026-10-05_agree.json"),
      "tiingo",
    ],
    ["twelvedata HTTP 500", ok("tiingo_aapl_2026-10-05.json"), reply(500, ""), "twelvedata"],
    [
      "twelvedata timeout",
      ok("tiingo_aapl_2026-10-05.json"),
      new DOMException("timed out", "TimeoutError"),
      "twelvedata",
    ],
    [
      "twelvedata API error body",
      ok("tiingo_aapl_2026-10-05.json"),
      ok("twelvedata_error_429.json"),
      "twelvedata",
    ],
  ] as const)(
    "one source down (%s) is source_unavailable",
    async (_name, tiingo, twelve, source) => {
      const error = expectError(await run(tiingo, twelve));
      expect(error).toMatchObject({ kind: "source_unavailable", source });
    },
  );

  it("malformed JSON is malformed_response", async () => {
    const error = expectError(
      await run(ok("tiingo_malformed.txt"), ok("twelvedata_aapl_2026-10-05_agree.json")),
    );
    expect(error).toMatchObject({ kind: "malformed_response", source: "tiingo" });
    expect(error.message).toMatch(/not valid JSON/);
  });

  it.each([
    ["wrong shape", reply(200, '{"detail":"Not found."}')],
    ["non-numeric close", ok("tiingo_bad_close.json")],
    ["negative close", reply(200, '[{"date":"2026-10-05T00:00:00.000Z","close":-1}]')],
  ])("tiingo %s is malformed_response", async (_name, tiingo) => {
    const error = expectError(await run(tiingo, ok("twelvedata_aapl_2026-10-05_agree.json")));
    expect(error).toMatchObject({ kind: "malformed_response", source: "tiingo" });
  });

  it("twelvedata wrong shape is malformed_response", async () => {
    const error = expectError(
      await run(ok("tiingo_aapl_2026-10-05.json"), reply(200, '{"status":"ok","values":"x"}')),
    );
    expect(error).toMatchObject({ kind: "malformed_response", source: "twelvedata" });
  });

  it.each([
    [
      "tiingo has no bar",
      ok("tiingo_empty.json"),
      ok("twelvedata_aapl_2026-10-05_agree.json"),
      "tiingo",
    ],
    [
      "twelvedata is stale",
      ok("tiingo_aapl_2026-10-05.json"),
      ok("twelvedata_aapl_stale.json"),
      "twelvedata",
    ],
  ] as const)("%s: missing_bar", async (_name, tiingo, twelve, source) => {
    const error = expectError(await run(tiingo, twelve));
    expect(error).toMatchObject({ kind: "missing_bar", source });
    expect(error.message).toContain(DATE);
  });

  it("sends keys in headers only, never in URLs, with a timeout signal", async () => {
    const http = fakeHttp(
      ok("tiingo_aapl_2026-10-05.json"),
      ok("twelvedata_aapl_2026-10-05_agree.json"),
    );
    await fetchPrevClose(
      { http, tiingoApiKey: TIINGO_KEY, twelveDataApiKey: TWELVE_KEY },
      "AAPL",
      DATE,
    );
    expect(http).toHaveBeenCalledTimes(2);
    for (const [url, init] of http.mock.calls) {
      expect(url).not.toContain(TIINGO_KEY);
      expect(url).not.toContain(TWELVE_KEY);
      expect(url.startsWith("https://")).toBe(true);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    const [[tiingoUrl, tiingoInit], [twelveUrl, twelveInit]] = http.mock.calls.sort(([a], [b]) =>
      a.localeCompare(b),
    ) as [Parameters<HttpGet>, Parameters<HttpGet>];
    expect(tiingoUrl).toBe(
      "https://api.tiingo.com/tiingo/daily/aapl/prices?startDate=2026-10-05&endDate=2026-10-05",
    );
    expect(tiingoInit.headers.Authorization).toBe(`Token ${TIINGO_KEY}`);
    expect(twelveUrl).toBe(
      "https://api.twelvedata.com/time_series?symbol=AAPL&interval=1day&outputsize=5",
    );
    expect(twelveInit.headers.Authorization).toBe(`apikey ${TWELVE_KEY}`);
  });

  it("error messages never contain API keys", async () => {
    const results = await Promise.all([
      run(reply(401, "bad key"), ok("twelvedata_error_429.json")),
      run(new Error("socket hang up"), ok("twelvedata_aapl_2026-10-05_agree.json")),
      run(ok("tiingo_malformed.txt"), ok("twelvedata_aapl_2026-10-05_agree.json")),
    ]);
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(TIINGO_KEY);
      expect(text).not.toContain(TWELVE_KEY);
    }
  });

  it("uses DEFAULT_TIMEOUT_MS unless overridden", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const http = fakeHttp(
      ok("tiingo_aapl_2026-10-05.json"),
      ok("twelvedata_aapl_2026-10-05_agree.json"),
    );
    const deps = { http, tiingoApiKey: TIINGO_KEY, twelveDataApiKey: TWELVE_KEY };
    await fetchPrevClose(deps, "AAPL", DATE);
    expect(spy).toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS);
    await fetchPrevClose({ ...deps, timeoutMs: 1_234 }, "AAPL", DATE);
    expect(spy).toHaveBeenCalledWith(1_234);
    spy.mockRestore();
  });

  it.each(["aapl", "", "AAPL/../x", "TOOLONGTICKER"])("rejects ticker %j", async (ticker) => {
    await expect(run(reply(200, "[]"), reply(200, "{}"), ticker)).rejects.toThrow(RangeError);
  });
});

describe("agreement arithmetic", () => {
  it("5 bps of the mean is the inclusive boundary", () => {
    // mean 100,000¢: 5 bps = 50¢.
    expect(withinSpread(99_975, 100_025)).toBe(true);
    expect(withinSpread(99_975, 100_026)).toBe(false);
  });

  it("withinSpread is symmetric and matches the exact rational definition", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 1, max: 1e9 }), (a, b) => {
        expect(withinSpread(a, b)).toBe(withinSpread(b, a));
        // |a − b| / ((a + b) / 2) ≤ 5 / 10,000, cross-multiplied in bigint.
        const exact = BigInt(Math.abs(a - b)) * 2n * 10_000n <= 5n * BigInt(a + b);
        expect(withinSpread(a, b)).toBe(exact);
      }),
    );
  });

  it("meanHalfUp rounds .5 up and lies between its inputs", () => {
    expect(meanHalfUp(1, 2)).toBe(2);
    expect(meanHalfUp(2, 2)).toBe(2);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), fc.integer({ min: 0, max: 1e12 }), (a, b) => {
        const m = meanHalfUp(a, b);
        expect(m).toBeGreaterThanOrEqual(Math.min(a, b));
        expect(m).toBeLessThanOrEqual(Math.max(a, b));
        expect(2 * m - (a + b)).toBeGreaterThanOrEqual(0);
        expect(2 * m - (a + b)).toBeLessThanOrEqual(1);
      }),
    );
  });
});
