/**
 * GET /api/pyth-quotes[?tickers=AAPL,MSFT]: Pyth live quotes proxied server-side (M3-10, D-055).
 *
 * This route will consume the Pyth client from services/automation/src/pyth/ (MR !86) once merged.
 * Until then, it returns mock data matching the PythQuotesResponse schema for UI development.
 *
 * PYTH_API_TOKEN is server-only and never exposed to the client bundle.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { MAG7, type Mag7Ticker } from "@/lib/market-data-shared";
import { PYTH_FEED_IDS, type PythQuotesResponse } from "@/lib/pyth-quotes";

export const dynamic = "force-dynamic";

const tickersParam = z
  .string()
  .transform((value) => value.split(",").map((part) => part.trim().toUpperCase()))
  .pipe(z.array(z.enum(MAG7)).min(1).max(MAG7.length));

/**
 * Mock Pyth quotes for development (until MR !86 merges).
 * Returns plausible prices with recent publish times.
 */
function getMockPythQuotes(tickers: readonly Mag7Ticker[]): PythQuotesResponse {
  const nowSecs = Math.floor(Date.now() / 1000);

  // Mock prices (cents) - roughly realistic values for demo
  const mockPrices: Record<Mag7Ticker, number> = {
    AAPL: 22500, // $225.00
    MSFT: 42000, // $420.00
    GOOGL: 17500, // $175.00
    AMZN: 19000, // $190.00
    NVDA: 13500, // $135.00
    META: 58000, // $580.00
    TSLA: 26000, // $260.00
  };

  const quotes = tickers.map((ticker) => ({
    ticker,
    price_cents: mockPrices[ticker],
    conf_cents: Math.floor(mockPrices[ticker] * 0.001), // ~0.1% confidence
    publish_time: nowSecs - Math.floor(Math.random() * 3), // 0-3 seconds ago
    feed_id: PYTH_FEED_IDS[ticker],
  }));

  return {
    quotes,
    unavailable: [],
    server_time: Date.now(),
  };
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

  // TODO: Once MR !86 merges, replace this with real Pyth client:
  // const pythClient = createPythClient({
  //   apiToken: process.env.PYTH_API_TOKEN!,
  // });
  // const quotes = await pythClient.getLatestPrices(parsed.data);

  const body = getMockPythQuotes(parsed.data);
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
