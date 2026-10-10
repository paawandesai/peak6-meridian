/**
 * GET /api/pyth-quotes[?tickers=AAPL,MSFT]: Pyth Pro live quotes proxied server-side (M3-10, D-055).
 *
 * Fetches live equity prices from Pyth Pro (Lazer) API with authenticated bearer token.
 * PYTH_API_TOKEN is server-only and never exposed to the client bundle.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { Decimal } from "decimal.js";

import { MAG7, type Mag7Ticker } from "@/lib/market-data-shared";
import { PYTH_FEED_IDS, type PythQuotesResponse, type PythQuote } from "@/lib/pyth-quotes";

export const dynamic = "force-dynamic";

const tickersParam = z
  .string()
  .transform((value) => value.split(",").map((part) => part.trim().toUpperCase()))
  .pipe(z.array(z.enum(MAG7)).min(1).max(MAG7.length));

/**
 * Pyth Pro API response schema (price feed message).
 */
const pythPriceSchema = z.object({
  price: z.string(), // Price as string to preserve precision
  conf: z.string(), // Confidence
  expo: z.number(), // Exponent
  publish_time: z.number(), // Unix timestamp
});

const pythFeedResponseSchema = z.object({
  id: z.string(), // Feed ID
  price: pythPriceSchema,
});

/**
 * Convert Pyth price (value * 10^expo) to integer cents using Decimal for precision.
 */
function pythPriceToCents(price: string, expo: number): number | null {
  try {
    const priceDecimal = new Decimal(price);
    const expoDecimal = new Decimal(10).pow(expo);
    const dollars = priceDecimal.times(expoDecimal);
    const cents = dollars.times(100);

    if (!cents.isFinite() || cents.isNegative() || cents.greaterThan(100_000_000)) {
      return null;
    }

    return Math.round(cents.toNumber());
  } catch {
    return null;
  }
}

/**
 * Fetches a single ticker's price from Pyth Pro API.
 */
async function fetchPythPrice(
  ticker: Mag7Ticker,
  apiToken: string,
  signal?: AbortSignal,
): Promise<PythQuote | null> {
  const feedId = PYTH_FEED_IDS[ticker];
  // Pyth Pro (Lazer) endpoint - replace with actual Pro endpoint when available
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
      },
      signal,
    });

    if (!response.ok) {
      console.error(`Pyth API error for ${ticker}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const feedData = data.parsed?.[0];
    if (!feedData) {
      console.error(`No price data for ${ticker}`);
      return null;
    }

    // Verify feed ID matches
    if (feedData.id !== feedId) {
      console.error(`Feed ID mismatch for ${ticker}: expected ${feedId}, got ${feedData.id}`);
      return null;
    }

    const parsed = pythFeedResponseSchema.parse(feedData);
    const priceCents = pythPriceToCents(parsed.price.price, parsed.price.expo);
    const confCents = pythPriceToCents(parsed.price.conf, parsed.price.expo);

    if (priceCents === null || confCents === null) {
      console.error(`Invalid price conversion for ${ticker}`);
      return null;
    }

    return {
      ticker,
      price_cents: priceCents,
      conf_cents: confCents,
      publish_time: parsed.price.publish_time,
      feed_id: feedId,
    };
  } catch (error) {
    console.error(`Failed to fetch Pyth price for ${ticker}:`, error);
    return null;
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

  // Fetch all tickers in parallel with 10s timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const results = await Promise.all(
      parsed.data.map((ticker) => fetchPythPrice(ticker, apiToken, controller.signal)),
    );

    const quotes = results.filter((q): q is PythQuote => q !== null);
    const unavailable = parsed.data.filter(
      (ticker) => !quotes.some((q) => q.ticker === ticker),
    );

    const body: PythQuotesResponse = {
      quotes,
      unavailable,
      server_time: Date.now(),
    };

    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } finally {
    clearTimeout(timeoutId);
  }
}
