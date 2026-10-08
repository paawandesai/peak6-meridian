// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { marketDataResponseSchema } from "@/lib/market-data-shared";

const FINNHUB = "finnhub-secret-xyz";
const TIINGO = "tiingo-secret-xyz";

async function loadRoute() {
  vi.resetModules();
  return import("./route");
}

const quoteResponse = (price: number): Response =>
  new Response(JSON.stringify({ c: price, t: 1_791_490_000 }), { status: 200 });

beforeEach(() => {
  vi.stubEnv("FINNHUB_API_KEY", FINNHUB);
  vi.stubEnv("TIINGO_API_KEY", TIINGO);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/market-data", () => {
  it("returns prices for the requested tickers in the documented shape", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(quoteResponse(232.45)));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await loadRoute();
    const response = await GET(new Request("http://localhost/api/market-data?tickers=aapl,MSFT"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = marketDataResponseSchema.parse(await response.json());
    expect(body.prices.map((p) => [p.ticker, p.price_cents, p.stale])).toEqual([
      ["AAPL", 23_245, false],
      ["MSFT", 23_245, false],
    ]);
    expect(body.unavailable).toEqual([]);
  });

  it("serves all seven tickers when none are requested", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(quoteResponse(100)));
    const { GET } = await loadRoute();
    const body = marketDataResponseSchema.parse(
      await (await GET(new Request("http://localhost/api/market-data"))).json(),
    );
    expect(body.prices).toHaveLength(7);
  });

  it("rejects unknown or malformed tickers with 400", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("must not be called")));
    const { GET } = await loadRoute();
    for (const query of ["tickers=ZZZZ", "tickers=", "tickers=AAPL,%20", "tickers=AAPL;DROP"]) {
      const response = await GET(new Request(`http://localhost/api/market-data?${query}`));
      expect(response.status).toBe(400);
    }
  });

  it("answers unavailable (200, no invented price) when the upstream is down and nothing is cached", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status: 503 })));
    const { GET } = await loadRoute();
    const body = marketDataResponseSchema.parse(
      await (await GET(new Request("http://localhost/api/market-data?tickers=TSLA"))).json(),
    );
    expect(body).toEqual({ prices: [], unavailable: ["TSLA"] });
  });

  it("never puts an API key in the response or in logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", () => Promise.reject(new Error(`connect failed ${FINNHUB} ${TIINGO}`)));
    const { GET } = await loadRoute();
    const response = await GET(new Request("http://localhost/api/market-data?tickers=AAPL"));
    const text = await response.text();
    expect(text).not.toContain(FINNHUB);
    expect(text).not.toContain(TIINGO);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(FINNHUB);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TIINGO);
    expect(warn).toHaveBeenCalled();
  });
});
