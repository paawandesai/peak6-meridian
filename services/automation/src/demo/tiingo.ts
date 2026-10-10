/**
 * M4-08: Tiingo historical price client for demo replay mode.
 * Fetches end-of-day prices for a specific historical date.
 * API key travels in Authorization header (never in URLs), matches prevCloses.ts pattern.
 */
import { z } from "zod";

import { parseDecimalToCents } from "../money";

export interface TiingoClient {
  /**
   * Fetch end-of-day close price for ticker on date.
   * @param ticker Stock symbol (e.g. "AAPL")
   * @param date YYYY-MM-DD
   * @returns Close price in integer cents
   * @throws If API fails, ticker not found, or date has no data
   */
  getEodClose(ticker: string, date: string): Promise<number>;
}

export interface TiingoClientDeps {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const tiingoSchema = z.array(
  z.object({ date: z.string(), close: z.union([z.number(), z.string()]) }).passthrough(),
);

/**
 * Create Tiingo client for historical prices (returns integer cents).
 * In production, pass real fetch and TIINGO_API_KEY.
 * In tests, pass a mock fetch that returns fixture data.
 */
export function createTiingoClient(deps: TiingoClientDeps): TiingoClient {
  return {
    async getEodClose(ticker: string, date: string): Promise<number> {
      const url =
        `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker.toLowerCase())}/prices` +
        `?startDate=${date}&endDate=${date}`;

      const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const response = await deps.fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Token ${deps.apiKey}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Tiingo API error ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = await response.json();
      const parsed = tiingoSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error(`Invalid Tiingo response: ${parsed.error.message}`);
      }

      const bar = parsed.data.find((row) => row.date.slice(0, 10) === date);
      if (!bar) {
        throw new Error(`No data from Tiingo for ${ticker} on ${date}`);
      }

      const closeCents = parseDecimalToCents(String(bar.close));
      if (closeCents === null || closeCents <= 0) {
        throw new Error(
          `Invalid close price for ${ticker} on ${date}: ${JSON.stringify(bar.close)}`,
        );
      }

      return closeCents;
    },
  };
}
