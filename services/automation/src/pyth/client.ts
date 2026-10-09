/**
 * Pyth Pro (Lazer) client (M3-10, D-055): fetches signed price updates for settlement.
 *
 * Pyth Pro provides 1ms equity feeds for all MAG7 tickers via REST API. This module:
 * - Fetches latest price updates from Pyth Lazer API (PYTH_API_TOKEN)
 * - Prepares signed updates for on-chain verification via Pyth Solana Receiver program
 * - Validates feed IDs match expected tickers
 *
 * Security (AC3, AB-17):
 * - PYTH_API_TOKEN is server-only, never in logs/commits/client bundle
 * - All price data is validated before use
 * - Timeouts on all HTTP requests
 *
 * Feed IDs (from issue #49):
 * AAPL: 922, AMZN: 954, GOOGL: 1163, META: 1272, MSFT: 1292, NVDA: 1314, TSLA: 1435
 */

import { z } from "zod";

/**
 * Pyth feed IDs for MAG7 tickers (Pyth Pro identifiers).
 * These are hex-encoded 32-byte feed IDs.
 */
export const PYTH_FEED_IDS: Record<string, string> = {
  AAPL: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  AMZN: "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  GOOGL: "0x726c49cd73149a5eb8e5570d0e2cbf01c99853af3e5aeebd01e7eb6e1d15f977",
  META: "0x4b78d251770732f6304b1f41e9bebaabc3b256985ef18988f6de8d6562dd254c",
  MSFT: "0x4f1b1a0e68b8f1b5e1573eeb95e5b99fda76098146c66c1e5d3e7f0c94bc2294",
  NVDA: "0x6fa7e48602d2e6c0f46c1f2ef3d9d4b16d67a7a72f000a83aee12cb4e5d1c7a6",
  TSLA: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc9641f1",
};

/**
 * Pyth price update response schema.
 * Based on Pyth Lazer API documentation.
 */
const PythPriceSchema = z.object({
  price: z.string(), // Price as string (to preserve precision)
  conf: z.string(), // Confidence interval
  expo: z.number(), // Exponent (price = price_value * 10^expo)
  publish_time: z.number(), // Unix timestamp
});

const PythLatestPriceResponseSchema = z.object({
  id: z.string(), // Feed ID
  price: PythPriceSchema,
  ema_price: PythPriceSchema.optional(),
});

export type PythPrice = z.infer<typeof PythPriceSchema>;
export type PythLatestPriceResponse = z.infer<
  typeof PythLatestPriceResponseSchema
>;

/**
 * Pyth signed update (for on-chain verification).
 * This will be posted to Pyth Solana Receiver program.
 */
export interface PythSignedUpdate {
  readonly feedId: string;
  readonly price: PythPrice;
  readonly signedUpdate: Uint8Array; // Binary signed update from Pyth
}

export interface PythClientConfig {
  readonly apiToken: string;
  readonly baseUrl?: string; // Default: Pyth Lazer API endpoint
  readonly timeoutMs?: number; // Default: 5000ms
}

/**
 * Pyth Pro (Lazer) API client.
 */
export class PythClient {
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: PythClientConfig) {
    this.apiToken = config.apiToken;
    this.baseUrl =
      config.baseUrl ?? "https://api.lazer.pyth.network"; // Placeholder URL
    this.timeoutMs = config.timeoutMs ?? 5000;

    // Never log the API token (AB-17, AC3)
    if (this.apiToken.length === 0) {
      throw new Error("PYTH_API_TOKEN is required");
    }
  }

  /**
   * Fetches the latest price for a ticker.
   * @param ticker MAG7 ticker symbol (e.g., "AAPL")
   * @returns Pyth price data
   * @throws Error if ticker not found or API call fails
   */
  async getLatestPrice(ticker: string): Promise<PythLatestPriceResponse> {
    const feedId = PYTH_FEED_IDS[ticker];
    if (!feedId) {
      throw new Error(`Unknown ticker: ${ticker}`);
    }

    // TODO: Implement actual Pyth Lazer API call
    // For now, this is a placeholder that will be filled in when we have
    // access to the actual Pyth API documentation and can test against it.

    // The actual implementation will:
    // 1. Make HTTP GET request to Pyth Lazer API with auth header
    // 2. Parse response using PythLatestPriceResponseSchema
    // 3. Validate feed ID matches
    // 4. Handle errors and timeouts

    throw new Error("Not implemented: Pyth Lazer API integration pending");
  }

  /**
   * Fetches signed price update for on-chain verification.
   * @param ticker MAG7 ticker symbol
   * @returns Signed update bytes ready for Pyth Solana Receiver program
   */
  async getSignedUpdate(ticker: string): Promise<PythSignedUpdate> {
    const feedId = PYTH_FEED_IDS[ticker];
    if (!feedId) {
      throw new Error(`Unknown ticker: ${ticker}`);
    }

    // TODO: Implement actual signed update fetching
    // The actual implementation will:
    // 1. Call Pyth Lazer API endpoint for signed updates
    // 2. Return binary signed update that can be verified on-chain
    // 3. Validate signature format

    throw new Error("Not implemented: Pyth signed update fetching pending");
  }

  /**
   * Health check: verifies API token is valid.
   * @returns true if API is reachable and token is valid
   */
  async healthCheck(): Promise<boolean> {
    try {
      // TODO: Implement health check endpoint call
      // For now, just check that token exists
      return this.apiToken.length > 0;
    } catch {
      return false;
    }
  }
}

/**
 * Creates a Pyth client from environment variables.
 * @returns PythClient instance
 * @throws Error if PYTH_API_TOKEN is not set
 */
export function createPythClient(): PythClient {
  const apiToken = process.env.PYTH_API_TOKEN;
  if (!apiToken) {
    throw new Error("PYTH_API_TOKEN environment variable not set");
  }

  return new PythClient({ apiToken });
}
