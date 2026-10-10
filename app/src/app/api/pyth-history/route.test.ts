import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/pyth-history", () => {
  beforeEach(() => {
    vi.stubEnv("PYTH_API_TOKEN", "test-token");
    vi.restoreAllMocks();
  });

  it("returns 503 when PYTH_API_TOKEN is not configured", async () => {
    vi.stubEnv("PYTH_API_TOKEN", "");
    const request = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.AAPL/USD&resolution=5&from=1000000&to=2000000",
    );
    const response = await GET(request as never);
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data).toEqual({ error: "PYTH_API_TOKEN not configured" });
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

  it("returns 502 on upstream error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const request = new Request(
      "http://localhost/api/pyth-history?symbol=Equity.US.TSLA/USD&resolution=1&from=1000000&to=2000000",
    );
    const response = await GET(request as never);
    expect(response.status).toBe(502);
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
});
