import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/pyth-history", () => {
  beforeEach(() => {
    vi.stubEnv("PYTH_API_TOKEN", "test-token");
    vi.restoreAllMocks();
  });

  it("returns 200 {s:no_data} when PYTH_API_TOKEN is not configured", async () => {
    vi.stubEnv("PYTH_API_TOKEN", "");
    const request = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.AAPL/USD&resolution=5&from=1000000&to=2000000",
    );
    const response = await GET(request as never);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ s: "no_data" });
  });

  it("returns 400 for invalid symbol", async () => {
    const request = new Request(
      "http://localhost/api/pyth-history?symbol=INVALID&resolution=5&from=1000000&to=2000000",
    );
    const response = await GET(request as never);
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid resolution", async () => {
    const request = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.AAPL/USD&resolution=999&from=1000000&to=2000000",
    );
    const response = await GET(request as never);
    expect(response.status).toBe(400);
  });

  it("proxies valid request and returns TradingView format", async () => {
    const mockData = {
      s: "ok" as const,
      t: [1000000, 1000300],
      o: [150.0, 151.0],
      h: [152.0, 153.0],
      l: [149.0, 150.5],
      c: [151.0, 152.5],
      v: [1000, 1500],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    const request = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.AAPL/USD&resolution=5&from=1000000&to=2000000",
    );
    const response = await GET(request as never);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual(mockData);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("pyth.dourolabs.app/v1/fixed_rate@200ms/history"),
      expect.objectContaining({
        headers: {
          Authorization: "Bearer test-token",
        },
      }),
    );
  });

  it("returns empty state for no_data status", async () => {
    const mockData = { s: "no_data" as const };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    const request = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.NVDA/USD&resolution=D&from=1000000&to=2000000",
    );
    const response = await GET(request as never);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ s: "no_data" });
  });

  it("returns 200 {s:no_data} on upstream error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const request = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.TSLA/USD&resolution=1&from=1000000&to=2000000",
    );
    const response = await GET(request as never);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ s: "no_data" });
  });

  it("never includes PYTH_API_TOKEN in response", async () => {
    const mockData = { s: "ok" as const, t: [1000000], c: [100.0] };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    const request = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.META/USD&resolution=15&from=1000000&to=2000000",
    );
    const response = await GET(request as never);
    const text = await response.text();
    expect(text).not.toContain("test-token");
  });

  it("caches responses for 60s per ticker + bucket", async () => {
    const mockData = { s: "ok" as const, t: [1000000], c: [100.0] };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });
    global.fetch = fetchMock;

    // First request
    const request1 = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.NVDA/USD&resolution=60&from=1000000&to=1500000",
    );
    const response1 = await GET(request1 as never);
    expect(response1.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second request (same bucket, should use cache)
    const request2 = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.NVDA/USD&resolution=60&from=1000000&to=1500000",
    );
    const response2 = await GET(request2 as never);
    expect(response2.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1, used cache

    const data1 = await response1.json();
    const data2 = await response2.json();
    expect(data1).toEqual(data2);
  });

  it("uses 5-minute buckets for cache keys", async () => {
    const mockData = { s: "ok" as const, t: [1000000], c: [100.0] };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });
    global.fetch = fetchMock;

    // Requests with different 'to' but same 5-min bucket should share cache
    const request1 = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.AAPL/USD&resolution=60&from=1000000&to=1500000",
    );
    await GET(request1 as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same bucket (1500000 rounds to 1499700)
    const request2 = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.AAPL/USD&resolution=60&from=1000000&to=1500299",
    );
    await GET(request2 as never);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Used cache
  });
});
