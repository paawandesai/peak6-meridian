/**
 * M4-08: Tests for Tiingo historical price client.
 * All tests use mocked fetch; never call the real Tiingo API.
 */
import { describe, it, expect } from "vitest";
import { createTiingoClient } from "./tiingo";

describe("Tiingo client", () => {
  it("fetches EOD close price", async () => {
    const mockFetch = async (url: string) => {
      expect(url).toContain("AAPL");
      expect(url).toContain("2024-10-08");
      expect(url).toContain("token=test-key");
      return {
        ok: true,
        json: async () => [{ date: "2024-10-08T00:00:00.000Z", close: 230.5 }],
      } as Response;
    };

    const client = createTiingoClient({
      apiKey: "test-key",
      fetch: mockFetch,
    });

    const close = await client.getEodClose("AAPL", "2024-10-08");
    expect(close).toBe(230.5);
  });

  it("redacts API key from logs", async () => {
    const logs: Array<{ level: string; event: string; data: unknown }> = [];

    const mockFetch = async () =>
      ({
        ok: true,
        json: async () => [{ date: "2024-10-08", close: 680.0 }],
      }) as Response;

    const client = createTiingoClient({
      apiKey: "secret-api-key-12345",
      fetch: mockFetch,
      log: (level, event, data) => logs.push({ level, event, data }),
    });

    await client.getEodClose("META", "2024-10-08");

    const fetchLog = logs.find((l) => l.event === "tiingo_fetch");
    expect(fetchLog).toBeDefined();
    expect(JSON.stringify(fetchLog)).not.toContain("secret-api-key-12345");
    expect(JSON.stringify(fetchLog)).toContain("token=***");
  });

  it("throws on HTTP error", async () => {
    const mockFetch = async () =>
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
    const mockFetch = async () =>
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
    const mockFetch = async () =>
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
