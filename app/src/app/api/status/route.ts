import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import "./reader"; // Auto-install StatusChainReader

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

/**
 * Chain reader interface for dependency injection.
 * Implemented by status-chain.ts (owned by !122).
 */
export interface StatusChainReader {
  /**
   * Fetch all markets for a trading date and compute invariants.
   * @param tradingDate - YYYYMMDD trading date
   * @returns Market invariant data
   */
  fetchMarketInvariants(tradingDate: number): Promise<MarketInvariant[]>;

  /**
   * Get the active trading date (today's ET date if markets exist, else most recent).
   * @returns YYYYMMDD trading date
   */
  getActiveDate(): Promise<number>;
}

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
// - 30s for vault/active data
// - 5min for markets with some unsettled
// - 1hr for fully settled dates
const cache = new Map<string, CacheEntry>();

const CACHE_VAULT_MS = 30_000; // 30s for vault balances
const CACHE_ACTIVE_MS = 5 * 60 * 1000; // 5min for active markets
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
 * Cached 30s with in-flight deduplication.
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

    // Get reader from global (set by status-chain.ts after !122 merges)
    const reader = (globalThis as { statusChainReader?: StatusChainReader }).statusChainReader;
    if (!reader) {
      return NextResponse.json(
        { s: "error", error: "Status chain reader not initialized" },
        { status: 503 }
      );
    }

    // Determine trading date
    const tradingDate = params.data.date
      ? parseDateParam(params.data.date)
      : await reader.getActiveDate();

    const cacheKey = `status:${tradingDate}`;
    const now = Date.now();

    // Check cache
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

    // Fetch data
    const fetchPromise = (async (): Promise<StatusResponse> => {
      try {
        const markets = await reader.fetchMarketInvariants(tradingDate);
        return {
          s: "ok",
          date: tradingDate,
          markets,
        };
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
