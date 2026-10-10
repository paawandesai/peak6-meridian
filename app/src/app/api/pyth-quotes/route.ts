/**
 * GET /api/pyth-quotes[?tickers=AAPL,MSFT]: Pyth Pro live quotes proxied server-side (M3-10, D-055).
 *
 * Fetches live equity prices from Pyth Pro (Lazer) API with authenticated bearer token.
 * PYTH_API_TOKEN is server-only and never exposed to the client bundle.
 * 2s server cache plus in-flight dedupe to limit upstream load (P0-4).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { Decimal } from "decimal.js";

import { MAG7, type Mag7Ticker } from "@/lib/market-data-shared";
import { type PythQuotesResponse, type PythQuote } from "@/lib/pyth-quotes";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 2_000;
/** Cache keyed by sorted ticker list to prevent cross-contamination (Markets/Trade use different sets). */
const cache = new Map<string, { data: PythQuotesResponse; at: number }>();
/** In-flight requests keyed by sorted ticker list. */
const inFlight = new Map<string, Promise<PythQuotesResponse>>();

/** Clears cache and in-flight maps (for tests). */
export function clearCache(): void {
  cache.clear();
  inFlight.clear();
}

const tickersParam = z
  .string()
  .transform((value) => value.split(",").map((part) => part.trim().toUpperCase()))
  .pipe(z.array(z.enum(MAG7)).min(1).max(MAG7.length));

/** Pyth Pro (Lazer) numeric feed ids, from https://history.pyth-lazer.dourolabs.app/history/v1/symbols. */
const PYTH_PRO_FEED_IDS: Record<Mag7Ticker, number> = {
  AAPL: 922,
  AMZN: 954,
  GOOGL: 1163,
  META: 1272,
  MSFT: 1292,
  NVDA: 1314,
  TSLA: 1435,
};

const PYTH_PRO_LATEST_URL = "https://pyth-lazer.dourolabs.app/v1/latest_price";

const proFeedSchema = z.object({
  priceFeedId: z.number().int(),
  price: z.string().optional(),
  exponent: z.number().int().optional(),
  confidence: z.union([z.string(), z.number()]).optional(),
  feedUpdateTimestamp: z.union([z.string(), z.number()]).optional(),
});

const proResponseSchema = z.object({
  parsed: z.object({
    timestampUs: z.string(),
    priceFeeds: z.array(proFeedSchema),
  }),
});

/**
 * Convert Pyth price (value * 10^expo) to integer cents using Decimal for precision.
 */
function pythPriceToCents(price: string, expo: number): number | null {
  try {
    const cents = new Decimal(price).times(new Decimal(10).pow(expo)).times(100);
    if (!cents.isFinite() || cents.isNegative() || cents.greaterThan(100_000_000)) {
      return null;
    }
    return Math.round(cents.toNumber());
  } catch {
    return null;
  }
}

/**
 * Fetches a single ticker's latest price from the Pyth Pro REST API (bearer token, server-side).
 */
async function fetchPythPrice(
  ticker: Mag7Ticker,
  apiToken: string,
  signal?: AbortSignal,
): Promise<PythQuote | null> {
  const feedId = PYTH_PRO_FEED_IDS[ticker];
  try {
    const response = await fetch(PYTH_PRO_LATEST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        priceFeedIds: [feedId],
        properties: ["price", "exponent", "confidence", "feedUpdateTimestamp"],
        formats: [],
        channel: "fixed_rate@200ms",
        jsonBinaryEncoding: "hex",
        parsed: true,
      }),
      signal,
    });

    if (!response.ok) {
      console.error(`Pyth API error for ${ticker}: ${response.status}`);
      return null;
    }

    const data = proResponseSchema.safeParse(await response.json());
    if (!data.success) {
      console.error(`Malformed Pyth response for ${ticker}`);
      return null;
    }
    const feed = data.data.parsed.priceFeeds.find((f) => f.priceFeedId === feedId);
    if (!feed || feed.price === undefined || feed.exponent === undefined) {
      console.error(`No price data for ${ticker}`);
      return null;
    }

    const priceCents = pythPriceToCents(feed.price, feed.exponent);
    const confCents =
      feed.confidence === undefined ? 0 : pythPriceToCents(String(feed.confidence), feed.exponent);
    if (priceCents === null || priceCents === 0 || confCents === null) {
      console.error(`Invalid price conversion for ${ticker}`);
      return null;
    }

    return {
      ticker,
      price_cents: priceCents,
      conf_cents: confCents,
      // feedUpdateTimestamp is when the price last changed (the last close after hours).
      publish_time: Math.floor(
        Number(feed.feedUpdateTimestamp ?? data.data.parsed.timestampUs) / 1_000_000,
      ),
      feed_id: String(feedId),
    };
  } catch (error) {
    console.error(`Failed to fetch Pyth price for ${ticker}:`, error);
    return null;
  }
}

/** Fetches and caches quotes for all tickers. Shares in-flight requests and caches for 2s. */
async function fetchAllQuotes(tickers: readonly Mag7Ticker[], apiToken: string): Promise<PythQuotesResponse> {
  // Fetch all tickers in parallel with 10s timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const results = await Promise.all(
      tickers.map((ticker) => fetchPythPrice(ticker, apiToken, controller.signal)),
    );

    const quotes = results.filter((q): q is PythQuote => q !== null);
    const unavailable = tickers.filter((ticker) => !quotes.some((q) => q.ticker === ticker));

    return {
      quotes,
      unavailable,
      server_time: Date.now(),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const raw = new URL(request.url).searchParams.get("tickers");
  const parsed =
    raw === null
      ? { success: true as const, data: MAG7 as unknown as Mag7Ticker[] }
      : tickersParam.safeParse(raw);

  if (!parsed.success) {
    return NextResponse.json({ error: "unknown or malformed tickers" }, { status: 400 });
  }

  const apiToken = process.env.PYTH_API_TOKEN;
  if (!apiToken) {
    console.error("PYTH_API_TOKEN not configured");
    return NextResponse.json({ error: "Pyth API not configured" }, { status: 503 });
  }

  // Key by sorted ticker list to prevent cross-contamination (Markets uses all MAG7, Trade uses subsets)
  const cacheKey = [...parsed.data].sort().join(",");

  // Check cache first (2s TTL)
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(cached.data, { headers: { "Cache-Control": "no-store" } });
  }

  // Share in-flight requests for the same ticker set
  let promise = inFlight.get(cacheKey);
  if (promise === undefined) {
    promise = fetchAllQuotes(parsed.data, apiToken);
    inFlight.set(cacheKey, promise);
    promise
      .then((data) => {
        cache.set(cacheKey, { data, at: Date.now() });
      })
      .catch(() => {
        // Failed fetch is not cached
      })
      .finally(() => {
        inFlight.delete(cacheKey);
      });
  }

  try {
    const body = await promise;
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to fetch Pyth quotes:", error);
    return NextResponse.json({ error: "Failed to fetch quotes" }, { status: 503 });
  }
}
