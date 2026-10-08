// @vitest-environment node
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import {
  createMarketDataService,
  type Fetcher,
  finnhubProvider,
  MAX_CACHE_MS,
  type Provider,
  providersFromEnv,
  tiingoProvider,
} from "./market-data-server";
import { dollarsToCents, type Mag7Ticker } from "./market-data-shared";

const KEY = "fake-key-for-tests";
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("dollarsToCents", () => {
  it("converts a decimal dollar price to integer cents without float multiplication", () => {
    expect(dollarsToCents(232.45)).toBe(23_245);
    expect(dollarsToCents(0.29)).toBe(29);
    expect(dollarsToCents(1.005)).toBe(100); // toFixed rounds the binary value, never invents cents
    expect(dollarsToCents(680)).toBe(68_000);
  });

  it("rejects non-prices", () => {
    for (const bad of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_000_000,
      "12",
      null,
      undefined,
    ]) {
      expect(dollarsToCents(bad)).toBeNull();
    }
  });

  it("round-trips every whole cent (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000_000 }), (cents) => {
        expect(dollarsToCents(cents / 100)).toBe(cents);
      }),
    );
  });
});

describe("finnhubProvider", () => {
  it("sends the key in a header, never in the URL, and parses the quote", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(json({ c: 232.45, t: 1_791_490_000 }));
    const quote = await finnhubProvider(KEY).quote("AAPL", fetcher);
    expect(quote).toEqual({
      price_cents: 23_245,
      as_of: new Date(1_791_490_000_000).toISOString(),
    });
    const [url, init] = fetcher.mock.calls[0] ?? ["", {}];
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>)["X-Finnhub-Token"]).toBe(KEY);
  });

  it("fails on no data, a bad status and a malformed body", async () => {
    await expect(
      finnhubProvider(KEY).quote("AAPL", () => Promise.resolve(json({ c: 0, t: 0 }))),
    ).rejects.toThrow("no price");
    await expect(
      finnhubProvider(KEY).quote("AAPL", () => Promise.resolve(json({}, 429))),
    ).rejects.toThrow("status 429");
    await expect(
      finnhubProvider(KEY).quote("AAPL", () => Promise.resolve(json({ c: "x" }))),
    ).rejects.toThrow();
  });
});

describe("tiingoProvider", () => {
  const row = (ticker: string, last: number | null) => ({
    ticker,
    last,
    tngoLast: last,
    timestamp: "2026-10-08T14:30:00+00:00",
  });

  it("sends the key in the Authorization header and picks the ticker's row", async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValue(json([row("MSFT", 410.1), row("AAPL", 232.45)]));
    const quote = await tiingoProvider(KEY).quote("AAPL", fetcher);
    expect(quote).toEqual({ price_cents: 23_245, as_of: "2026-10-08T14:30:00.000Z" });
    const [url, init] = fetcher.mock.calls[0] ?? ["", {}];
    expect(url).toContain("tickers=aapl");
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Token ${KEY}`);
  });

  it("fails when the ticker is missing or the price is null", async () => {
    await expect(
      tiingoProvider(KEY).quote("AAPL", () => Promise.resolve(json([row("MSFT", 1)]))),
    ).rejects.toThrow("no price");
    await expect(
      tiingoProvider(KEY).quote("AAPL", () => Promise.resolve(json([row("AAPL", null)]))),
    ).rejects.toThrow("no price");
  });
});

describe("providersFromEnv", () => {
  it("lists Finnhub then Tiingo and skips unset or empty keys", () => {
    expect(
      providersFromEnv({ FINNHUB_API_KEY: "a", TIINGO_API_KEY: "b" }).map((p) => p.name),
    ).toEqual(["finnhub", "tiingo"]);
    expect(
      providersFromEnv({ FINNHUB_API_KEY: "", TIINGO_API_KEY: "b" }).map((p) => p.name),
    ).toEqual(["tiingo"]);
    expect(providersFromEnv({})).toEqual([]);
  });
});

/** A provider whose quotes and failures a test scripts. */
function scripted(
  quotes: Partial<Record<Mag7Ticker, number>>,
  name = "p",
): Provider & { calls: number } {
  const provider = {
    name,
    calls: 0,
    quote(ticker: Mag7Ticker) {
      provider.calls += 1;
      const cents = quotes[ticker];
      return cents === undefined
        ? Promise.reject(new Error(`boom ${KEY}`))
        : Promise.resolve({ price_cents: cents, as_of: "2026-10-08T14:30:00.000Z" });
    },
  };
  return provider;
}

function service(providers: Provider[], extra: { cacheMs?: number } = {}) {
  let time = 1_000_000;
  const log = vi.fn();
  const svc = createMarketDataService({
    providers,
    fetcher: () => Promise.reject(new Error("unused")),
    now: () => time,
    log,
    ...extra,
  });
  return { svc, log, advance: (ms: number) => (time += ms), set: (t: number) => (time = t) };
}

describe("createMarketDataService", () => {
  it("returns fresh prices and caches for under 5 s", async () => {
    const p = scripted({ AAPL: 23_245 });
    const { svc, advance } = service([p]);
    const first = await svc.get(["AAPL"]);
    expect(first).toEqual({
      prices: [
        { ticker: "AAPL", price_cents: 23_245, as_of: "2026-10-08T14:30:00.000Z", stale: false },
      ],
      unavailable: [],
    });
    advance(MAX_CACHE_MS - 1);
    await svc.get(["AAPL"]);
    expect(p.calls).toBe(1);
    advance(1);
    await svc.get(["AAPL"]);
    expect(p.calls).toBe(2);
  });

  it("never caches longer than 5 s even if configured to", async () => {
    const p = scripted({ AAPL: 100 });
    const { svc, advance } = service([p], { cacheMs: 60_000 });
    await svc.get(["AAPL"]);
    advance(MAX_CACHE_MS);
    await svc.get(["AAPL"]);
    expect(p.calls).toBe(2);
  });

  it("returns the last price with stale: true when the upstream fails (never a fabricated one)", async () => {
    const quotes: Partial<Record<Mag7Ticker, number>> = { AAPL: 23_245 };
    const p = scripted(quotes);
    const { svc, advance, log } = service([p]);
    await svc.get(["AAPL"]);
    delete quotes.AAPL; // upstream now fails
    advance(MAX_CACHE_MS + 1);
    const stale = await svc.get(["AAPL"]);
    expect(stale.prices).toEqual([
      { ticker: "AAPL", price_cents: 23_245, as_of: "2026-10-08T14:30:00.000Z", stale: true },
    ]);
    expect(stale.unavailable).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it("does not retry the providers inside the cache window after a failure (negative cache)", async () => {
    const quotes: Partial<Record<Mag7Ticker, number>> = {};
    const p = scripted(quotes);
    const { svc, advance } = service([p]);
    await svc.get(["AAPL"]);
    await svc.get(["AAPL"]);
    await svc.get(["AAPL"]);
    expect(p.calls).toBe(1); // an outage costs one provider round per window, not one per request
    advance(MAX_CACHE_MS);
    await svc.get(["AAPL"]);
    expect(p.calls).toBe(2);
    quotes.AAPL = 100; // upstream recovers: the next window succeeds and clears the failure
    advance(MAX_CACHE_MS);
    expect((await svc.get(["AAPL"])).prices[0]).toMatchObject({ price_cents: 100, stale: false });
    advance(MAX_CACHE_MS);
    await svc.get(["AAPL"]);
    expect(p.calls).toBe(4);
  });

  it("still returns the stale price during the negative-cache window", async () => {
    const quotes: Partial<Record<Mag7Ticker, number>> = { AAPL: 23_245 };
    const p = scripted(quotes);
    const { svc, advance } = service([p]);
    await svc.get(["AAPL"]);
    delete quotes.AAPL;
    advance(MAX_CACHE_MS + 1);
    const first = await svc.get(["AAPL"]);
    const second = await svc.get(["AAPL"]);
    expect(first.prices[0]?.stale).toBe(true);
    expect(second.prices[0]?.stale).toBe(true);
    expect(p.calls).toBe(2);
  });

  it("reports a ticker with no price and no cache as unavailable, not as a made-up price", async () => {
    const { svc } = service([scripted({ AAPL: 100 })]);
    const result = await svc.get(["AAPL", "MSFT"]);
    expect(result.prices.map((price) => price.ticker)).toEqual(["AAPL"]);
    expect(result.unavailable).toEqual(["MSFT"]);
  });

  it("falls back to the next provider and uses no price from another ticker", async () => {
    const first = scripted({}, "first");
    const second = scripted({ NVDA: 12_345 }, "second");
    const { svc } = service([first, second]);
    const result = await svc.get(["NVDA"]);
    expect(result.prices[0]).toMatchObject({ ticker: "NVDA", price_cents: 12_345, stale: false });
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it("with no provider configured every ticker is unavailable and the misconfiguration is logged once", async () => {
    const { svc, log } = service([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      event: "market_data_no_providers",
      detail: "set FINNHUB_API_KEY and/or TIINGO_API_KEY on the server",
    });
    expect(await svc.get(["AAPL"])).toEqual({ prices: [], unavailable: ["AAPL"] });
  });

  it("coalesces concurrent requests into one upstream call per ticker", async () => {
    const p = scripted({ AAPL: 100 });
    const { svc } = service([p]);
    await Promise.all([svc.get(["AAPL"]), svc.get(["AAPL", "AAPL"]), svc.get(["AAPL"])]);
    expect(p.calls).toBe(1);
  });

  it("logs provider, ticker and a short reason only, never the key or an error message", async () => {
    const { svc, log } = service([scripted({}, "finnhub")]);
    await svc.get(["AAPL"]);
    const entry = log.mock.calls[0]?.[0] as Record<string, string>;
    expect(entry).toEqual({
      event: "market_data_upstream_failed",
      provider: "finnhub",
      ticker: "AAPL",
      reason: "Error",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });
});
