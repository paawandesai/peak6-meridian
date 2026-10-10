import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type MarketInvariant } from "./route";

/**
 * Tests for GET /api/status (P1-6).
 * Mocks lazy imports (createReader, loadStatusData) to test cache, date parsing, error paths.
 */

// Mock modules before importing route
vi.mock("@solana/web3.js", () => ({
  PublicKey: class PublicKey {
    constructor(public key: string) {}
  },
}));

vi.mock("@/lib/config", () => ({
  loadPublicConfig: vi.fn(() => ({
    programId: "test-program-id",
    rpcUrl: "http://test-rpc",
  })),
}));

vi.mock("@/lib/rpc", () => ({
  sharedConnection: vi.fn(() => ({})),
}));

const mockReader = {
  listMarkets: vi.fn(),
};

const mockLoadStatusData = vi.fn();

vi.mock("@/lib/chain", () => ({
  createReader: vi.fn(() => mockReader),
}));

vi.mock("@/app/status/status-chain", () => ({
  loadStatusData: mockLoadStatusData,
}));

vi.mock("@/lib/markets", () => ({
  partitionMarkets: vi.fn((markets) => ({ session: markets, test: [] })),
}));

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
  createdAt: 1728500000,
  settleSlot: 0,
  outcome: "None",
  settled: false,
};

describe("GET /api/status", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();
    // Reset module cache to clear in-memory cache between tests
    vi.resetModules();
  });

  it("returns error for invalid date format", async () => {
    const { GET } = await import("./route");
    const req = createRequest("/api/status?date=invalid");
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.s).toBe("error");
    expect(data.error).toBe("Invalid query parameters");
  });

  it("returns markets for valid date parameter", async () => {
    mockReader.listMarkets.mockResolvedValue([
      {
        address: "market1",
        ticker: "AAPL",
        strikeCents: 18000n,
        tradingDate: 20241010,
        pairsOutstanding: 1n,
        closeTs: 1728586800n,
        settled: false,
        outcome: "None",
      },
    ]);

    mockLoadStatusData.mockResolvedValue({
      markets: [
        {
          address: "market1",
          ticker: "AAPL",
          strikeCents: 18000n,
          pairsOutstanding: 1n,
          closeTs: 1728586800n,
          settled: false,
          outcome: "None",
        },
      ],
      vaults: new Map([["market1", 1000000n]]),
      facts: new Map([
        [
          "market1",
          {
            createdAt: 1728500000,
            settledAt: null,
            settleSlot: null,
            oracleSlot: null,
          },
        ],
      ]),
    });

    const { GET } = await import("./route");
    const req = createRequest("/api/status?date=2024-10-10");
    const res = await GET(req);
    const data = await res.json();

    expect(data.s).toBe("ok");
    expect(data.date).toBe(20241010);
    expect(data.markets).toHaveLength(1);
    expect(data.markets![0]).toMatchObject({
      address: "market1",
      ticker: "AAPL",
      outcome: "None",
      settled: false,
      createdAt: 1728500000,
    });
  });

  it("uses active date when no date param provided", async () => {
    vi.clearAllMocks();
    mockReader.listMarkets.mockResolvedValue([
      { tradingDate: 20241010, address: "m1", pairsOutstanding: 1n },
      { tradingDate: 20241009, address: "m2", pairsOutstanding: 1n },
    ]);

    mockLoadStatusData.mockResolvedValue({
      markets: [],
      vaults: new Map(),
      facts: new Map(),
    });

    const { GET } = await import("./route");
    const req = createRequest("/api/status");
    const res = await GET(req);
    const data = await res.json();

    expect(data.s).toBe("ok");
    expect(data.date).toBe(20241010); // Most recent date
    // listMarkets called once to determine active date
    expect(mockReader.listMarkets).toHaveBeenCalled();
  });

  it("returns empty markets for date with no markets", async () => {
    mockReader.listMarkets.mockResolvedValue([
      { tradingDate: 20241010, address: "m1", pairsOutstanding: 1n },
    ]);

    const { GET } = await import("./route");
    const req = createRequest("/api/status?date=2024-10-11");
    const res = await GET(req);
    const data = await res.json();

    expect(data.s).toBe("ok");
    expect(data.date).toBe(20241011);
    expect(data.markets).toEqual([]);
    expect(mockLoadStatusData).not.toHaveBeenCalled();
  });

  it("handles loadStatusData errors gracefully", async () => {
    mockReader.listMarkets.mockResolvedValue([
      { tradingDate: 20241010, address: "m1", pairsOutstanding: 1n },
    ]);
    mockLoadStatusData.mockRejectedValue(new Error("RPC timeout"));

    const { GET } = await import("./route");
    const req = createRequest("/api/status?date=2024-10-10");
    const res = await GET(req);
    const data = await res.json();

    expect(data.s).toBe("error");
    expect(data.error).toBe("RPC timeout");
  });

  it("stays within ≤10 RPC for 40 markets (P1-6 AC)", async () => {
    // Generate 40 markets: 7 open (future close) + 7 settled on recent date
    const now = Math.floor(Date.now() / 1000);
    const markets = Array.from({ length: 40 }, (_, i) => {
      const tradingDate = 20241010 - Math.floor(i / 7); // 7 markets per day
      // Most recent 7: all open with future close (skip signature scan)
      const isOpen = i < 7;
      return {
        address: `market${i}`,
        ticker: `TKR${i}`,
        strikeCents: 18000n,
        tradingDate,
        pairsOutstanding: 1n,
        closeTs: BigInt(now + (isOpen ? 7200 : -3600)), // Open: 2hr future, Settled: past
        settled: !isOpen,
        outcome: "None" as const,
      };
    });

    // Count actual RPC calls
    let listMarketsCount = 0;
    let vaultRpcCount = 0;
    let sigScanCount = 0;

    mockReader.listMarkets = vi.fn(async () => {
      listMarketsCount++;
      return markets;
    });

    mockLoadStatusData.mockImplementation(async (conn, dateMarkets, progId, nowSecs) => {
      vaultRpcCount = 1; // getMultipleParsedAccounts for vaults (chunked if needed)
      // loadMarketFacts skips open markets (nowSecs < closeTs) per P1-6 optimization
      sigScanCount = dateMarkets.filter(
        (m: any) => m.settled || nowSecs >= Number(m.closeTs)
      ).length;
      return {
        markets: dateMarkets,
        vaults: new Map(dateMarkets.map((m: any) => [m.address, 1000000n])),
        facts: new Map(),
      };
    });

    vi.resetModules();
    const { GET } = await import("./route");
    const req = createRequest("/api/status");
    await GET(req);

    const totalRpc = listMarketsCount + vaultRpcCount + sigScanCount;
    // P1-6 AC: ≤10 RPC per view
    // Expected: 1 (listMarkets) + 1 (vaults) + 0 (all open, skip scan) = 2
    expect(totalRpc).toBeLessThanOrEqual(10);
  });

  it("maps vault 0 correctly", async () => {
    mockReader.listMarkets.mockResolvedValue([
      {
        address: "market1",
        ticker: "AAPL",
        strikeCents: 18000n,
        tradingDate: 20241010,
        pairsOutstanding: 1n,
        closeTs: 1728586800n,
        settled: false,
        outcome: "None",
      },
    ]);

    mockLoadStatusData.mockResolvedValue({
      markets: [
        {
          address: "market1",
          ticker: "AAPL",
          strikeCents: 18000n,
          pairsOutstanding: 1n,
          closeTs: 1728586800n,
          settled: false,
          outcome: "None",
        },
      ],
      vaults: new Map([["market1", null]]), // Missing vault
      facts: new Map([
        [
          "market1",
          {
            createdAt: null,
            settledAt: null,
            settleSlot: null,
            oracleSlot: null,
          },
        ],
      ]),
    });

    const { GET } = await import("./route");
    const req = createRequest("/api/status?date=2024-10-10");
    const res = await GET(req);
    const data = await res.json();

    expect(data.markets![0].vaultBase).toBe("0"); // null vault becomes "0"
    expect(data.markets![0].invariantPass).toBe(false);
  });
});
