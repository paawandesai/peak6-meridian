/**
 * M4-08: Tests for Tiingo historical price client.
 * All tests use mocked fetch; never call the real Tiingo API.
 */
import { describe, it, expect } from "vitest";
import { createTiingoClient } from "./tiingo";

describe("Tiingo client", () => {
  it("fetches EOD close price in integer cents with Authorization header", async () => {
    const mockFetch: typeof fetch = async (url, init) => {
      expect(String(url)).toContain("aapl"); // lowercased
      expect(String(url)).toContain("2024-10-08");
      expect(String(url)).not.toContain("token"); // key NOT in URL
      expect(init?.headers).toHaveProperty("Authorization", "Token test-key");
      return {
        ok: true,
        status: 200,
        json: async () => [{ date: "2024-10-08T00:00:00.000Z", close: "230.50" }],
        text: async () => "",
      } as Response;
    };

    const client = createTiingoClient({
      apiKey: "test-key",
      fetch: mockFetch,
    });

    const closeCents = await client.getEodClose("AAPL", "2024-10-08");
    expect(closeCents).toBe(23050); // 230.50 dollars = 23050 cents
  });

  it("handles numeric close prices", async () => {
    const mockFetch: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => [{ date: "2024-10-08", close: 680.0 }],
        text: async () => "",
      }) as Response;

    const client = createTiingoClient({
      apiKey: "test-key",
      fetch: mockFetch,
    });

    const closeCents = await client.getEodClose("META", "2024-10-08");
    expect(closeCents).toBe(68000); // 680.00 dollars = 68000 cents
  });

  it("throws on HTTP error", async () => {
    const mockFetch: typeof fetch = async () =>
      ({
        ok: false,
        status: 401,
        text: async () => "Unauthorized: Invalid API key",
      }) as Response;

    const client = createTiingoClient({
      apiKey: "bad-key",
      fetch: mockFetch,
    });

    await expect(client.getEodClose("AAPL", "2024-10-08")).rejects.toThrow(/Tiingo API error 401/);
  });

  it("throws when no data returned", async () => {
    const mockFetch: typeof fetch = async () =>
      ({
        ok: true,
        json: async () => [],
      }) as Response;

    const client = createTiingoClient({
      apiKey: "test-key",
      fetch: mockFetch,
    });

    await expect(client.getEodClose("INVALID", "2024-10-08")).rejects.toThrow(
      /No data from Tiingo/,
    );
  });

  it("throws on invalid response structure", async () => {
    const mockFetch: typeof fetch = async () =>
      ({
        ok: true,
        json: async () => [{ date: "2024-10-08" }], // missing 'close'
      }) as Response;

    const client = createTiingoClient({
      apiKey: "test-key",
      fetch: mockFetch,
    });

    await expect(client.getEodClose("AAPL", "2024-10-08")).rejects.toThrow(
      /Invalid Tiingo response/,
    );
  });
});
