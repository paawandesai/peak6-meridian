/**
 * M4-08: Tiingo historical price client for demo replay mode.
 * Fetches end-of-day prices for a specific historical date.
 * API key is from TIINGO_API_KEY env var (never logged).
 */

export interface TiingoEodPrice {
  readonly ticker: string;
  readonly date: string; // YYYY-MM-DD
  readonly close: number; // dollars
}

export interface TiingoClient {
  /**
   * Fetch end-of-day close price for ticker on date.
   * @param ticker Stock symbol (e.g. "AAPL")
   * @param date YYYY-MM-DD
   * @returns Close price in dollars
   * @throws If API fails, ticker not found, or date has no data
   */
  getEodClose(ticker: string, date: string): Promise<number>;
}

export interface TiingoClientDeps {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly log?: (level: string, event: string, data: unknown) => void;
}

/**
 * Create Tiingo client for historical prices.
 * In production, pass real fetch and TIINGO_API_KEY.
 * In tests, pass a mock fetch that returns fixture data.
 */
export function createTiingoClient(deps: TiingoClientDeps): TiingoClient {
  return {
    async getEodClose(ticker: string, date: string): Promise<number> {
      const url = `https://api.tiingo.com/tiingo/daily/${ticker}/prices?startDate=${date}&endDate=${date}&token=${deps.apiKey}`;

      deps.log?.(
        "info",
        "tiingo_fetch",
        // SECURITY: never log the API key; log only the ticker and date
        { ticker, date, url: url.replace(/token=[^&]+/, "token=***") },
      );

      const response = await deps.fetch(url, {
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Tiingo API error ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as Array<{
        date: string;
        close: number;
      }>;

      if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No data from Tiingo for ${ticker} on ${date}`);
      }

      const bar = data[0];
      if (!bar || typeof bar.close !== "number") {
        throw new Error(
          `Invalid Tiingo response for ${ticker} on ${date}: ${JSON.stringify(bar).slice(0, 100)}`,
        );
      }

      deps.log?.("info", "tiingo_close", { ticker, date, close: bar.close });

      return bar.close;
    },
  };
}
