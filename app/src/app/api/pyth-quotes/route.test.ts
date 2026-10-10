/**
 * Tests for Pyth quotes API route (M3-10, D-055): Pyth Pro REST latest_price.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET, clearCache } from "./route";

const pro = (id: number, price: string, exponent = -5, confidence?: string) => ({
  parsed: {
    timestampUs: "1700000000000000",
    priceFeeds: [{ priceFeedId: id, price, exponent, ...(confidence ? { confidence } : {}) }],
  },
});

describe("/api/pyth-quotes", () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIG_ENV, PYTH_API_TOKEN: "test-token" };
    vi.clearAllMocks();
    clearCache();
  });

  afterEach(() => {
    process.env = ORIG_ENV;
  });

  it("returns 503 when PYTH_API_TOKEN is not configured", async () => {
    delete process.env.PYTH_API_TOKEN;
    const response = await GET(new Request("http://localhost/api/pyth-quotes"));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("Pyth API not configured");
  });

  it("returns 400 for invalid tickers", async () => {
    const response = await GET(new Request("http://localhost/api/pyth-quotes?tickers=XXX"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("malformed");
  });

  it("POSTs the Pyth Pro feed id with a bearer token and returns cents", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => pro(922, "22512345", -5, "5000") });
    const response = await GET(new Request("http://localhost/api/pyth-quotes?tickers=AAPL"));
    expect(response.status).toBe(200);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://pyth-lazer.dourolabs.app/v1/latest_price");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(init.body).priceFeedIds).toEqual([922]);
    const body = await response.json();
    expect(body.quotes[0]).toMatchObject({
      ticker: "AAPL",
      price_cents: 22512,
      conf_cents: 5,
      publish_time: 1700000000,
      feed_id: "922",
    });
    expect(body.unavailable).toEqual([]);
  });

  it("marks a ticker unavailable when the response has another feed id", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => pro(954, "100") });
    const body = await (
      await GET(new Request("http://localhost/api/pyth-quotes?tickers=AAPL"))
    ).json();
    expect(body.quotes).toHaveLength(0);
    expect(body.unavailable).toContain("AAPL");
  });

  it("handles API errors gracefully", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const body = await (
      await GET(new Request("http://localhost/api/pyth-quotes?tickers=AAPL"))
    ).json();
    expect(body.quotes).toHaveLength(0);
    expect(body.unavailable).toContain("AAPL");
  });

  it("fetches all MAG7 when no tickers specified", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await GET(new Request("http://localhost/api/pyth-quotes"));
    expect(global.fetch).toHaveBeenCalledTimes(7);
  });

  it("rejects negative prices", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => pro(922, "-100") });
    const body = await (
      await GET(new Request("http://localhost/api/pyth-quotes?tickers=AAPL"))
    ).json();
    expect(body.quotes).toHaveLength(0);
    expect(body.unavailable).toContain("AAPL");
  });
});
