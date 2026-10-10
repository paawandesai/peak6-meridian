import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

/**
 * Per-market invariant data for Status page (P1-6).
 */
export type MarketInvariant = {
  /** Market address. */
  readonly address: string;
  /** Ticker symbol. */
  readonly ticker: string;
  /** Strike price in cents. */
  readonly strikeCents: number;
  /** Vault balance in USDC base units. */
  readonly vaultBase: string;
  /** Pairs outstanding (contracts). */
  readonly pairsOutstanding: string;
  /** Expected vault (pairs × $1 in base units). */
  readonly expectedVaultBase: string;
  /** Pass/fail: vault === pairs × 1 USDC. */
  readonly invariantPass: boolean;
  /** Market close timestamp (Unix seconds). */
  readonly closeTs: number;
  /** Settle timestamp (Unix seconds), 0 if not settled. */
  readonly settledAt: number;
  /** Oracle price timestamp at settlement (Unix seconds), 0 if not settled. */
  readonly oracleAsOf: number;
  /** Market created timestamp (Unix seconds), 0 if unknown. */
  readonly createdAt: number;
  /** Settle slot, 0 if not settled. */
  readonly settleSlot: number;
  /** Market outcome from on-chain settled field. */
  readonly outcome: "Yes" | "No" | "None";
  /** On-chain settled flag. */
  readonly settled: boolean;
};

export type StatusResponse = {
  /** Status code: "ok" | "error". */
  readonly s: "ok" | "error";
  /** Trading date (YYYYMMDD). */
  readonly date?: number;
  /** Per-market invariant rows. */
  readonly markets?: readonly MarketInvariant[];
  /** Error message if s === "error". */
  readonly error?: string;
};

const querySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

type CacheEntry = {
  data: StatusResponse;
  expiresAt: number;
};

// In-memory cache with dynamic TTL (P1-6 optimization)
// - 5min for markets with some unsettled
// - 1hr for fully settled dates
const cache = new Map<string, CacheEntry>();

const CACHE_ACTIVE_MS = 30 * 1000; // 30s for active markets (P1-6 AC)
const CACHE_SETTLED_MS = 60 * 60 * 1000; // 1hr for settled markets

// In-flight request deduplication
const inflightRequests = new Map<string, Promise<StatusResponse>>();

/**
 * Parse YYYY-MM-DD to YYYYMMDD trading date.
 */
function parseDateParam(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error("Invalid date format");
  }
  return year * 10000 + month * 100 + day;
}

/**
 * GET /api/status?date=YYYY-MM-DD
 * Returns per-market invariant data for a trading date.
 * Cached 30s (P1-6) with in-flight deduplication.
 */
export async function GET(request: NextRequest): Promise<NextResponse<StatusResponse>> {
  try {
    const searchParams = request.nextUrl.searchParams;
    const params = querySchema.safeParse({
      date: searchParams.get("date") ?? undefined,
    });

    if (!params.success) {
      return NextResponse.json(
        { s: "error", error: "Invalid query parameters" },
        { status: 400 }
      );
    }

    // Lazy imports to avoid bundling anchor/client code during Next.js build
    const { PublicKey } = await import("@solana/web3.js");
    const { loadStatusData } = await import("@/app/status/status-chain");
    const { createReader } = await import("@/lib/chain");
    const { loadPublicConfig } = await import("@/lib/config");
    const { sharedConnection } = await import("@/lib/rpc");

    const config = loadPublicConfig();
    const reader = createReader(config);
    const connection = sharedConnection(config.rpcUrl);
    const programId = new PublicKey(config.programId);

    // Build cache key (use "today" for active date requests)
    const cacheKey = params.data.date
      ? `status:${parseDateParam(params.data.date)}`
      : "status:today";
    const now = Date.now();

    // Check cache BEFORE any RPC
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return NextResponse.json(cached.data);
    }

    // Check in-flight requests
    const inflight = inflightRequests.get(cacheKey);
    if (inflight) {
      const data = await inflight;
      return NextResponse.json(data);
    }

    // Fetch data (determine date and load markets in one RPC call)
    const fetchPromise = (async (): Promise<StatusResponse> => {
      try {
        const USDC_BASE_PER_CONTRACT = 1_000_000n;

        // Load all markets (single RPC, reused for both date determination and filtering)
        const allMarkets = await reader.listMarkets();

        // Determine trading date from param or active date
        let tradingDate: number;
        if (params.data.date) {
          tradingDate = parseDateParam(params.data.date);
        } else {
          // Active date = most recent trading date
          if (allMarkets.length === 0) {
            const now = new Date();
            const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
            tradingDate = etDate.getFullYear() * 10000 + (etDate.getMonth() + 1) * 100 + etDate.getDate();
          } else {
            const dates = [...new Set(allMarkets.map((m) => m.tradingDate))].sort((a, b) => b - a);
            tradingDate = dates[0] ?? 0;
          }
        }

        const dateMarkets = allMarkets.filter((m) => m.tradingDate === tradingDate);

        if (dateMarkets.length === 0) {
          return { s: "ok", date: tradingDate, markets: [] };
        }

        // Load status data (vaults + facts)
        const nowSecs = Math.floor(Date.now() / 1000);
        const statusData = await loadStatusData(connection, dateMarkets, programId, nowSecs);

        // Build invariant rows
        const markets: MarketInvariant[] = statusData.markets.map((market) => {
          const vaultBase = statusData.vaults.get(market.address) ?? null;
          const facts = statusData.facts.get(market.address);
          const pairsOutstanding = BigInt(market.pairsOutstanding);
          const expectedVaultBase = pairsOutstanding * USDC_BASE_PER_CONTRACT;
          const invariantPass = vaultBase !== null && vaultBase === expectedVaultBase;

          return {
            address: market.address,
            ticker: market.ticker,
            strikeCents: Number(market.strikeCents),
            vaultBase: vaultBase?.toString() ?? "0",
            pairsOutstanding: pairsOutstanding.toString(),
            expectedVaultBase: expectedVaultBase.toString(),
            invariantPass,
            closeTs: Number(market.closeTs),
            settledAt: facts?.settledAt ?? 0,
            oracleAsOf: Number(facts?.oracleSlot ?? 0n),
            createdAt: facts?.createdAt ?? 0,
            settleSlot: Number(facts?.settleSlot ?? 0n),
            outcome: market.outcome,
            settled: market.settled,
          };
        });

        return { s: "ok", date: tradingDate, markets };
      } catch (error) {
        console.error("Failed to fetch status data:", error);
        return {
          s: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    })();

    inflightRequests.set(cacheKey, fetchPromise);

    try {
      const data = await fetchPromise;

      // Cache successful responses with dynamic TTL (P1-6 optimization)
      if (data.s === "ok" && data.markets) {
        const allSettled = data.markets.every((m) => m.settledAt > 0);
        const ttl = allSettled ? CACHE_SETTLED_MS : CACHE_ACTIVE_MS;
        cache.set(cacheKey, {
          data,
          expiresAt: now + ttl,
        });
      }

      return NextResponse.json(data);
    } finally {
      inflightRequests.delete(cacheKey);
    }
  } catch (error) {
    console.error("Status API error:", error);
    return NextResponse.json(
      {
        s: "error",
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
