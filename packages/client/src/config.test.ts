import { PublicKey } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  configParamsArg,
  configParamsBatches,
  DEFAULT_MAX_CONF_BPS,
  DEFAULT_MAX_STALENESS_SLOTS,
  DEFAULT_OVERRIDE_DELAY_SECS,
  MAX_TICKER_SLOTS_PER_CALL,
  TICKER_COUNT,
  tickerSlotArg,
  type TickerInput,
} from "./config";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

function ticker(symbol: string, seed: number): TickerInput {
  return {
    symbol,
    feeds: [PublicKey.unique(), PublicKey.unique()],
    feedHashes: [new Uint8Array(32).fill(seed), new Uint8Array(32).fill(seed + 100)],
  };
}

const scalars = {
  automationAuthority: PublicKey.unique(),
  maxStalenessSlots: DEFAULT_MAX_STALENESS_SLOTS,
  maxConfBps: DEFAULT_MAX_CONF_BPS,
  overrideDelaySecs: DEFAULT_OVERRIDE_DELAY_SECS,
};

describe("ticker slots", () => {
  it("encodes a slot with the on-chain layout", () => {
    const arg = tickerSlotArg({ index: 5, ticker: ticker("META", 1) });
    expect(arg.index).toBe(5);
    expect(arg.ticker.symbol).toEqual([77, 69, 84, 65, 0, 0, 0, 0]);
    expect(arg.ticker.feeds).toHaveLength(2);
    expect(arg.ticker.feedHashes).toEqual([new Array(32).fill(1), new Array(32).fill(101)]);
  });

  it("rejects bad indexes, symbols and hash lengths", () => {
    expect(() => tickerSlotArg({ index: 7, ticker: ticker("META", 1) })).toThrow(/0-6/);
    expect(() => tickerSlotArg({ index: -1, ticker: ticker("META", 1) })).toThrow(/0-6/);
    expect(() => tickerSlotArg({ index: 1.5, ticker: ticker("META", 1) })).toThrow(/0-6/);
    expect(() => tickerSlotArg({ index: 0, ticker: ticker("meta", 1) })).toThrow(/upper-case/);
    const short: TickerInput = {
      ...ticker("META", 1),
      feedHashes: [new Uint8Array(31), new Uint8Array(32)],
    };
    expect(() => tickerSlotArg({ index: 0, ticker: short })).toThrow(/32 bytes/);
  });
});

describe("configParamsArg", () => {
  it("converts bigint scalars to BN and keeps the rest", () => {
    const arg = configParamsArg({ ...scalars, tickers: [{ index: 0, ticker: ticker("AAPL", 1) }] });
    expect(arg.maxStalenessSlots.toString()).toBe("30");
    expect(arg.overrideDelaySecs.toString()).toBe("3600");
    expect(arg.maxConfBps).toBe(5);
    expect(arg.automationAuthority.equals(scalars.automationAuthority)).toBe(true);
    expect(arg.tickers).toHaveLength(1);
  });

  it("rejects more than six slots, duplicate slots and out-of-range scalars", () => {
    const seven = MAG7.map((symbol, index) => ({ index, ticker: ticker(symbol, index) }));
    expect(() => configParamsArg({ ...scalars, tickers: seven })).toThrow(/at most 6/);
    const dup = [
      { index: 0, ticker: ticker("AAPL", 1) },
      { index: 0, ticker: ticker("MSFT", 2) },
    ];
    expect(() => configParamsArg({ ...scalars, tickers: dup })).toThrow(/distinct/);
    expect(() => configParamsArg({ ...scalars, maxStalenessSlots: 0n, tickers: [] })).toThrow(
      /positive/,
    );
    for (const bps of [0, 10_001, 1.5]) {
      expect(() => configParamsArg({ ...scalars, maxConfBps: bps, tickers: [] })).toThrow(
        /1-10000/,
      );
    }
    expect(() => configParamsArg({ ...scalars, overrideDelaySecs: -1n, tickers: [] })).toThrow(
      /negative/,
    );
    expect(configParamsArg({ ...scalars, maxConfBps: 10_000, tickers: [] }).maxConfBps).toBe(
      10_000,
    );
  });
});

describe("configParamsBatches", () => {
  it("splits the MAG7 into an initialise call of six and an update call of one", () => {
    const batches = configParamsBatches(
      scalars,
      MAG7.map((symbol, index) => ticker(symbol, index)),
    );
    expect(batches.map((batch) => batch.tickers.map((slot) => slot.index))).toEqual([
      [0, 1, 2, 3, 4, 5],
      [6],
    ]);
    expect(batches[1]?.tickers[0]?.ticker.symbol).toBe("TSLA");
    expect(batches.every((batch) => batch.maxConfBps === scalars.maxConfBps)).toBe(true);
  });

  it("always yields at least one call, each within the per-call cap, covering every slot once", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: TICKER_COUNT }), (count) => {
        const tickers = MAG7.slice(0, count).map((symbol, index) => ticker(symbol, index));
        const batches = configParamsBatches(scalars, tickers);
        const indexes = batches.flatMap((batch) => batch.tickers.map((slot) => slot.index));
        return (
          batches.length >= 1 &&
          batches.every((batch) => batch.tickers.length <= MAX_TICKER_SLOTS_PER_CALL) &&
          batches.every(
            (batch) => configParamsArg(batch).tickers.length === batch.tickers.length,
          ) &&
          JSON.stringify(indexes) === JSON.stringify([...Array(count).keys()])
        );
      }),
    );
  });

  it("rejects more than seven tickers", () => {
    const eight = [...MAG7, "NFLX"].map((symbol, index) => ticker(symbol, index));
    expect(() => configParamsBatches(scalars, eight)).toThrow(/at most 7/);
  });
});
