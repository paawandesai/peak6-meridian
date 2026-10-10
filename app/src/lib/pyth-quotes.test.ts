/**
 * Tests for Pyth quote utilities (M3-10, D-055).
 */

import { describe, it, expect } from "vitest";
import {
  PYTH_FEED_IDS,
  PYTH_FRESHNESS_THRESHOLD_MS,
  isPythQuoteStale,
  formatQuoteAge,
  pythQuoteSchema,
} from "./pyth-quotes";

describe("PYTH_FEED_IDS", () => {
  it("contains all MAG7 tickers", () => {
    const tickers = Object.keys(PYTH_FEED_IDS);
    expect(tickers).toEqual(["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA"]);
  });

  it("all feed IDs are valid hex strings", () => {
    Object.values(PYTH_FEED_IDS).forEach((feedId) => {
      expect(feedId).toMatch(/^0x[a-f0-9]{64}$/);
    });
  });
});

describe("isPythQuoteStale", () => {
  it("returns false for fresh quotes (< 5s old)", () => {
    const nowMs = 1000000000;
    const publishTimeSecs = Math.floor(nowMs / 1000) - 4; // 4 seconds ago
    expect(isPythQuoteStale(publishTimeSecs, nowMs)).toBe(false);
  });

  it("returns true for stale quotes (>= 5s old)", () => {
    const nowMs = 1000000000;
    const publishTimeSecs = Math.floor(nowMs / 1000) - 5; // exactly 5 seconds ago
    expect(isPythQuoteStale(publishTimeSecs, nowMs)).toBe(true);
  });

  it("returns true for very old quotes", () => {
    const nowMs = 1000000000;
    const publishTimeSecs = Math.floor(nowMs / 1000) - 300; // 5 minutes ago
    expect(isPythQuoteStale(publishTimeSecs, nowMs)).toBe(true);
  });

  it("uses correct threshold from constant", () => {
    expect(PYTH_FRESHNESS_THRESHOLD_MS).toBe(5000);
  });
});

describe("formatQuoteAge", () => {
  it("formats ages under 60 seconds as seconds", () => {
    const nowMs = 1000000000;
    expect(formatQuoteAge(Math.floor(nowMs / 1000) - 0, nowMs)).toBe("0s ago");
    expect(formatQuoteAge(Math.floor(nowMs / 1000) - 15, nowMs)).toBe("15s ago");
    expect(formatQuoteAge(Math.floor(nowMs / 1000) - 59, nowMs)).toBe("59s ago");
  });

  it("formats ages >= 60 seconds as minutes", () => {
    const nowMs = 1000000000;
    expect(formatQuoteAge(Math.floor(nowMs / 1000) - 60, nowMs)).toBe("1m ago");
    expect(formatQuoteAge(Math.floor(nowMs / 1000) - 120, nowMs)).toBe("2m ago");
    expect(formatQuoteAge(Math.floor(nowMs / 1000) - 300, nowMs)).toBe("5m ago");
  });
});

describe("pythQuoteSchema", () => {
  it("validates a well-formed Pyth quote", () => {
    const valid = {
      ticker: "AAPL",
      price_cents: 22500,
      conf_cents: 50,
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.AAPL,
    };
    expect(pythQuoteSchema.parse(valid)).toEqual(valid);
  });

  it("rejects invalid ticker", () => {
    const invalid = {
      ticker: "INVALID",
      price_cents: 22500,
      conf_cents: 50,
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.AAPL,
    };
    expect(() => pythQuoteSchema.parse(invalid)).toThrow();
  });

  it("rejects negative price", () => {
    const invalid = {
      ticker: "AAPL",
      price_cents: -100,
      conf_cents: 50,
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.AAPL,
    };
    expect(() => pythQuoteSchema.parse(invalid)).toThrow();
  });

  it("rejects negative confidence", () => {
    const invalid = {
      ticker: "AAPL",
      price_cents: 22500,
      conf_cents: -10,
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.AAPL,
    };
    expect(() => pythQuoteSchema.parse(invalid)).toThrow();
  });

  it("accepts zero confidence", () => {
    const valid = {
      ticker: "AAPL",
      price_cents: 22500,
      conf_cents: 0,
      publish_time: 1700000000,
      feed_id: PYTH_FEED_IDS.AAPL,
    };
    expect(pythQuoteSchema.parse(valid)).toEqual(valid);
  });
});
