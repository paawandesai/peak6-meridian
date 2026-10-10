/**
 * Tests for Pyth quotes API route (M3-10, D-055).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "./route";
import { PYTH_FEED_IDS } from "@/lib/pyth-quotes";

describe("/api/pyth-quotes", () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIG_ENV, PYTH_API_TOKEN: "test-token" };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = ORIG_ENV;
  });

  it("returns 503 when PYTH_API_TOKEN is not configured", async () => {
    delete process.env.PYTH_API_TOKEN;
    const request = new Request("http://localhost/api/pyth-quotes");
    const response = await GET(request);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("Pyth API not configured");
  });

  it("returns 400 for invalid tickers", async () => {
    const request = new Request("http://localhost/api/pyth-quotes?tickers=INVALID");
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("malformed");
  });

  it("fetches quotes for requested tickers with Authorization header", async () => {
    const mockResponse = {
      parsed: [
        {
          id: PYTH_FEED_IDS.AAPL,
          price: {
            price: "22500",
            conf: "50",
            expo: -2,
            publish_time: 1700000000,
          },
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const request = new Request("http://localhost/api/pyth-quotes?tickers=AAPL");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(PYTH_FEED_IDS.AAPL),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );

    const body = await response.json();
    expect(body.quotes).toHaveLength(1);
    expect(body.quotes[0]).toMatchObject({
      ticker: "AAPL",
      price_cents: 22500,
      conf_cents: 50,
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.AAPL,
    });
  });

  it("rejects mismatched feed ID", async () => {
    const mockResponse = {
      parsed: [
        {
          id: "0xwrongfeedid",
          price: {
            price: "22500",
            conf: "50",
            expo: -2,
            publish_time: 1700000000,
          },
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const request = new Request("http://localhost/api/pyth-quotes?tickers=AAPL");
    const response = await GET(request);

    const body = await response.json();
    expect(body.quotes).toHaveLength(0);
    expect(body.unavailable).toContain("AAPL");
  });

  it("handles API errors gracefully", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const request = new Request("http://localhost/api/pyth-quotes?tickers=AAPL");
    const response = await GET(request);

    const body = await response.json();
    expect(body.quotes).toHaveLength(0);
    expect(body.unavailable).toContain("AAPL");
  });

  it("converts prices using Decimal math (not float)", async () => {
    const mockResponse = {
      parsed: [
        {
          id: PYTH_FEED_IDS.NVDA,
          price: {
            price: "13567",
            conf: "13",
            expo: -2,
            publish_time: 1700000000,
          },
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const request = new Request("http://localhost/api/pyth-quotes?tickers=NVDA");
    const response = await GET(request);

    const body = await response.json();
    expect(body.quotes[0].price_cents).toBe(13567);
    expect(body.quotes[0].conf_cents).toBe(13);
  });

  it("fetches all MAG7 when no tickers specified", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ parsed: [] }),
    });

    const request = new Request("http://localhost/api/pyth-quotes");
    await GET(request);

    expect(global.fetch).toHaveBeenCalledTimes(7);
  });

  it("rejects invalid price values", async () => {
    const mockResponse = {
      parsed: [
        {
          id: PYTH_FEED_IDS.AAPL,
          price: {
            price: "-1000",
            conf: "50",
            expo: -2,
            publish_time: 1700000000,
          },
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const request = new Request("http://localhost/api/pyth-quotes?tickers=AAPL");
    const response = await GET(request);

    const body = await response.json();
    expect(body.quotes).toHaveLength(0);
    expect(body.unavailable).toContain("AAPL");
  });
});
