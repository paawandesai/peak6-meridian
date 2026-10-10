import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type StatusChainReader, type MarketInvariant } from "./route";
import { NextRequest } from "next/server";

// Re-import GET in each test to avoid cache pollution
let GET: typeof import("./route").GET;

const mockReader: StatusChainReader = {
  fetchMarketInvariants: vi.fn(),
  getActiveDate: vi.fn(),
};

// Install mock reader
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers(); // Use real timers for most tests
  (globalThis as { statusChainReader?: StatusChainReader }).statusChainReader = mockReader;

  // Clear module cache and re-import to reset in-memory cache
  vi.resetModules();
  const module = await import("./route");
  GET = module.GET;
});

afterEach(() => {
  vi.useRealTimers();
});

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

const mockMarket: MarketInvariant = {
  address: "market1",
  ticker: "AAPL",
  strikeCents: 18000,
  vaultBase: "1000000",
  pairsOutstanding: "1",
  expectedVaultBase: "1000000",
  invariantPass: true,
  closeTs: 1728586800,
  settledAt: 0,
  oracleAsOf: 0,
};

describe("GET /api/status", () => {
  it("returns market invariants for active date when no date param", async () => {
    vi.mocked(mockReader.getActiveDate).mockResolvedValue(20261010);
    vi.mocked(mockReader.fetchMarketInvariants).mockResolvedValue([mockMarket]);

    const req = createRequest("/api/status");
    const res = await GET(req);
    const data = await res.json();

    expect(data.s).toBe("ok");
    expect(data.date).toBe(20261010);
    expect(data.markets).toHaveLength(1);
    expect(mockReader.getActiveDate).toHaveBeenCalledTimes(1);
  });

  it("returns market invariants for specified date", async () => {
    vi.mocked(mockReader.fetchMarketInvariants).mockResolvedValue([mockMarket]);

    const req = createRequest("/api/status?date=2026-10-10");
    const res = await GET(req);
    const data = await res.json();

    expect(data.s).toBe("ok");
    expect(data.date).toBe(20261010);
    expect(mockReader.fetchMarketInvariants).toHaveBeenCalledWith(20261010);
  });

  it("validates date parameter format", async () => {
    const req = createRequest("/api/status?date=invalid");
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.s).toBe("error");
    expect(data.error).toBe("Invalid query parameters");
  });

  it("caches responses for 30 seconds", async () => {
    vi.mocked(mockReader.getActiveDate).mockResolvedValue(20261010);
    vi.mocked(mockReader.fetchMarketInvariants).mockResolvedValue([mockMarket]);

    const req1 = createRequest("/api/status");
    await GET(req1);

    expect(mockReader.fetchMarketInvariants).toHaveBeenCalledTimes(1);

    // Second request within 30s should use cache
    const req2 = createRequest("/api/status");
    await GET(req2);

    expect(mockReader.fetchMarketInvariants).toHaveBeenCalledTimes(1); // Still 1
  });

  it("expires cache after 30 seconds", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    vi.mocked(mockReader.getActiveDate).mockResolvedValue(20261010);
    vi.mocked(mockReader.fetchMarketInvariants).mockResolvedValue([mockMarket]);

    const req1 = createRequest("/api/status");
    await GET(req1);

    expect(mockReader.fetchMarketInvariants).toHaveBeenCalledTimes(1);

    // Advance time by 31 seconds
    vi.setSystemTime(now + 31_000);

    // Second request after 30s should re-fetch
    const req2 = createRequest("/api/status");
    await GET(req2);

    expect(mockReader.fetchMarketInvariants).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("deduplicates in-flight requests", async () => {
    vi.mocked(mockReader.getActiveDate).mockResolvedValue(20261010);
    let resolvePromise: (value: MarketInvariant[]) => void;
    const promise = new Promise<MarketInvariant[]>((resolve) => {
      resolvePromise = resolve;
    });
    vi.mocked(mockReader.fetchMarketInvariants).mockReturnValue(promise);

    // Start two concurrent requests
    const req1 = createRequest("/api/status");
    const req2 = createRequest("/api/status");
    const [promise1, promise2] = [GET(req1), GET(req2)];

    // Resolve the fetch
    if (resolvePromise) {
      resolvePromise([mockMarket]);
    }
    await Promise.all([promise1, promise2]);

    // Should only fetch once despite two concurrent requests
    expect(mockReader.fetchMarketInvariants).toHaveBeenCalledTimes(1);
  });

  it("returns error when reader not initialized", async () => {
    (globalThis as { statusChainReader?: StatusChainReader }).statusChainReader = undefined;

    const req = createRequest("/api/status");
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(503);
    expect(data.s).toBe("error");
    expect(data.error).toBe("Status chain reader not initialized");
  });

  it("returns error when fetch fails", async () => {
    vi.mocked(mockReader.getActiveDate).mockResolvedValue(20261010);
    vi.mocked(mockReader.fetchMarketInvariants).mockRejectedValue(
      new Error("RPC timeout")
    );

    const req = createRequest("/api/status");
    const res = await GET(req);
    const data = await res.json();

    expect(data.s).toBe("error");
    expect(data.error).toBe("RPC timeout");
  });

  it("parses date parameter correctly", async () => {
    vi.mocked(mockReader.fetchMarketInvariants).mockResolvedValue([mockMarket]);

    const req = createRequest("/api/status?date=2024-12-25");
    const res = await GET(req);
    const data = await res.json();

    expect(data.s).toBe("ok");
    expect(data.date).toBe(20241225);
    expect(mockReader.fetchMarketInvariants).toHaveBeenCalledWith(20241225);
  });

  it("does not cache error responses", async () => {
    vi.mocked(mockReader.getActiveDate).mockResolvedValue(20261010);
    vi.mocked(mockReader.fetchMarketInvariants)
      .mockRejectedValueOnce(new Error("First error"))
      .mockResolvedValueOnce([mockMarket]);

    // First request errors
    const req1 = createRequest("/api/status");
    const res1 = await GET(req1);
    const data1 = await res1.json();
    expect(data1.s).toBe("error");

    // Second request should re-fetch (errors not cached)
    const req2 = createRequest("/api/status");
    const res2 = await GET(req2);
    const data2 = await res2.json();
    expect(data2.s).toBe("ok");
    expect(mockReader.fetchMarketInvariants).toHaveBeenCalledTimes(2);
  });
});
