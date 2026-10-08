/** GET /api/market-data[?tickers=AAPL,MSFT]: live stock prices proxied server-side (M2-05). */
import { NextResponse } from "next/server";
import { z } from "zod";

import { MAG7 } from "@/lib/market-data-shared";
import {
  ALL_TICKERS,
  createMarketDataService,
  type MarketDataService,
  providersFromEnv,
} from "@/lib/market-data-server";

export const dynamic = "force-dynamic";

let service: MarketDataService | undefined;

function getService(): MarketDataService {
  service ??= createMarketDataService({
    providers: providersFromEnv({
      FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
      TIINGO_API_KEY: process.env.TIINGO_API_KEY,
    }),
    fetcher: (url, init) => fetch(url, init),
    now: () => Date.now(),
    log: (entry) => {
      console.warn(JSON.stringify(entry));
    },
  });
  return service;
}

const tickersParam = z
  .string()
  .transform((value) => value.split(",").map((part) => part.trim().toUpperCase()))
  .pipe(z.array(z.enum(MAG7)).min(1).max(MAG7.length));

export async function GET(request: Request): Promise<NextResponse> {
  const raw = new URL(request.url).searchParams.get("tickers");
  const parsed =
    raw === null ? { success: true as const, data: ALL_TICKERS } : tickersParam.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "unknown or malformed tickers" }, { status: 400 });
  }
  const body = await getService().get(parsed.data);
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
