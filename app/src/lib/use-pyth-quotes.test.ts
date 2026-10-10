/**
 * Tests for usePythQuotes hook (M3-10, D-055).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePythQuotes } from "./use-pyth-quotes";
import { PYTH_FEED_IDS } from "./pyth-quotes";

describe("usePythQuotes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches quotes from /api/pyth-quotes", async () => {
    const mockResponse = {
      quotes: [
        {
          ticker: "AAPL",
          price_cents: 22500,
          conf_cents: 50,
          publish_time: 1700000000,
          feed_id: PYTH_FEED_IDS.AAPL,
        },
      ],
      unavailable: [],
      server_time: Date.now(),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const { result, unmount } = renderHook(() => usePythQuotes());

    expect(result.current.loading).toBe(true);
    expect(result.current.quotes).toEqual({});

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.quotes).toEqual({
      AAPL: mockResponse.quotes[0],
    });
    expect(result.current.error).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith("/api/pyth-quotes");

    unmount();
  });

  it("fetches specific tickers when provided", async () => {
    const mockResponse = {
      quotes: [
        {
          ticker: "AAPL",
          price_cents: 22500,
          conf_cents: 50,
          publish_time: 1700000000,
          feed_id: PYTH_FEED_IDS.AAPL,
        },
        {
          ticker: "MSFT",
          price_cents: 42000,
          conf_cents: 80,
          publish_time: 1700000000,
          feed_id: PYTH_FEED_IDS.MSFT,
        },
      ],
      unavailable: [],
      server_time: Date.now(),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const { result, unmount } = renderHook(() => usePythQuotes(["AAPL", "MSFT"]));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/pyth-quotes?tickers=AAPL,MSFT");
    expect(result.current.quotes).toHaveProperty("AAPL");
    expect(result.current.quotes).toHaveProperty("MSFT");

    unmount();
  });

  it("handles fetch errors gracefully", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const { result, unmount } = renderHook(() => usePythQuotes());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("Network error");
    expect(result.current.quotes).toEqual({});

    unmount();
  });

  it("handles HTTP errors", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const { result, unmount } = renderHook(() => usePythQuotes());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toContain("500");

    unmount();
  });
});
