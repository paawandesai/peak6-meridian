import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

/**
 * Pyth Pro History API response schema (TradingView format).
 * https://pyth.dourolabs.app/v1/fixed_rate@200ms/history
 */
const PythHistorySchema = z.object({
  s: z.enum(["ok", "no_data", "error"]),
  t: z.array(z.number()).optional(),
  o: z.array(z.number()).optional(),
  h: z.array(z.number()).optional(),
  l: z.array(z.number()).optional(),
  c: z.array(z.number()).optional(),
  v: z.array(z.number()).optional(),
});

const QuerySchema = z.object({
  symbol: z.string().regex(/^Equity\.US\.(AAPL|MSFT|GOOGL|AMZN|NVDA|META|TSLA)\/USD$/),
  resolution: z.enum(["1", "5", "15", "60", "D"]),
  from: z.string().regex(/^\d+$/),
  to: z.string().regex(/^\d+$/),
});

/**
 * GET /api/pyth-history - Proxy to Pyth Pro History API (server-side only, never exposes token).
 * Returns TradingView-format candlestick data for Lightweight Charts.
 */
export async function GET(request: NextRequest) {
  const token = process.env.PYTH_API_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "PYTH_API_TOKEN not configured" }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const params = {
    symbol: searchParams.get("symbol"),
    resolution: searchParams.get("resolution"),
    from: searchParams.get("from"),
    to: searchParams.get("to"),
  };

  const parsed = QuerySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }

  const url = new URL("https://pyth.dourolabs.app/v1/fixed_rate@200ms/history");
  url.searchParams.set("symbol", parsed.data.symbol);
  url.searchParams.set("resolution", parsed.data.resolution);
  url.searchParams.set("from", parsed.data.from);
  url.searchParams.set("to", parsed.data.to);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(4_000),
    });

    if (!response.ok) {
      return NextResponse.json({ error: "Upstream error" }, { status: 502 });
    }

    const data = await response.json();
    const validated = PythHistorySchema.safeParse(data);
    if (!validated.success) {
      return NextResponse.json({ error: "Invalid upstream response" }, { status: 502 });
    }

    return NextResponse.json(validated.data);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return NextResponse.json({ error: "Upstream timeout" }, { status: 504 });
    }
    return NextResponse.json({ error: "Request failed" }, { status: 502 });
  }
}
