/**
 * GET /api/pyth-quotes[?tickers=AAPL,MSFT]: Pyth live quotes proxied server-side (M3-10, D-055).
 *
 * Fetches live equity prices from Pyth Hermes API.
 * PYTH_API_TOKEN is server-only and never exposed to the client bundle.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { MAG7, type Mag7Ticker } from "@/lib/market-data-shared";
import { PYTH_FEED_IDS, type PythQuotesResponse, type PythQuote } from "@/lib/pyth-quotes";

export const dynamic = "force-dynamic";

const tickersParam = z
  .string()
  .transform((value) => value.split(",").map((part) => part.trim().toUpperCase()))
  .pipe(z.array(z.enum(MAG7)).min(1).max(MAG7.length));

/**
 * Pyth Hermes API response schema (simplified for what we need).
 */
const pythApiPriceSchema = z.object({
  price: z.string(),
  conf: z.string(),
  expo: z.number(),
  publish_time: z.number(),
});

/**
 * Fetches a single ticker's price from Pyth Hermes API.
 */
async function fetchPythPrice(
  ticker: Mag7Ticker,
  signal?: AbortSignal,
): Promise<PythQuote | null> {
  const feedId = PYTH_FEED_IDS[ticker];
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
      signal,
    });

    if (!response.ok) {
      console.error(`Pyth API error for ${ticker}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const priceData = data.parsed?.[0]?.price;
    if (!priceData) {
      console.error(`No price data for ${ticker}`);
      return null;
    }

    const parsed = pythApiPriceSchema.parse(priceData);

    // Convert price from Pyth format (price * 10^expo) to integer cents
    const priceValue = parseFloat(parsed.price);
    const expo = parsed.expo;
    const priceFloat = priceValue * Math.pow(10, expo);
    const priceCents = Math.round(priceFloat * 100);

    const confValue = parseFloat(parsed.conf);
    const confFloat = confValue * Math.pow(10, expo);
    const confCents = Math.round(confFloat * 100);

    return {
      ticker,
      price_cents: priceCents,
      conf_cents: confCents,
      publish_time: parsed.publish_time,
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

  // Fetch all tickers in parallel with 10s timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const results = await Promise.all(
      parsed.data.map((ticker) => fetchPythPrice(ticker, controller.signal)),
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
