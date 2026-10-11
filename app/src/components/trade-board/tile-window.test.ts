import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fair, NOW, quotes } from "@/components/fair-value/test-support";
import { market } from "@/test-utils";
import type { PythQuote } from "@/lib/pyth-quotes";
import {
  BOARD_TICKERS,
  belowIndex,
  orderTiles,
  type StrikeCell,
  strikeWindow,
  TILE_WINDOW,
  type TileModel,
  tileLadder,
  tileStateText,
} from "./tile-window";

const CLOSE = 1_791_489_600n; // 2026-10-08 16:00 ET
const LATER_CLOSE = CLOSE + 86_400n;

function cell(dollars: number, overrides: Partial<Parameters<typeof market>[0]> = {}): StrikeCell {
  return {
    market: market({
      address: `Mkt${dollars}x${String(overrides.closeTs ?? CLOSE)}`.padEnd(44, "1"),
      ticker: "NVDA",
      strikeCents: BigInt(dollars * 100),
      tradingDate: 20261008,
      closeTs: CLOSE,
      ...overrides,
    }),
    quotes: quotes(50, 52),
    fair: fair(),
  };
}

function pyth(priceCents: number): PythQuote {
  return {
    ticker: "NVDA",
    price_cents: priceCents,
    conf_cents: 0,
    publish_time: NOW - 2,
    feed_id: "feed",
  };
}

function tile(overrides: Partial<TileModel> = {}): TileModel {
  return { ticker: "NVDA", open: [], closed: [], pythQuote: undefined, ...overrides };
}

const strikes = (...dollars: number[]) => dollars.map((d) => BigInt(d * 100));

describe("orderTiles", () => {
  it("returns all seven tickers in board order, empty when the caller left one out", () => {
    const tiles = orderTiles([]);
    expect(tiles.map((t) => t.ticker)).toEqual([...BOARD_TICKERS]);
    expect(tiles.every((t) => t.open.length === 0 && t.closed.length === 0)).toBe(true);
  });

  it("keeps the caller's tile data and reorders it", () => {
    const nvda = tile({ open: [cell(180)] });
    const aapl = tile({ ticker: "AAPL", open: [cell(220)] });
    const out = orderTiles([nvda, aapl]);
    expect(out[0]).toBe(aapl);
    expect(out[5]).toBe(nvda);
  });
});

describe("belowIndex", () => {
  it("is the last strike at or below live, -1 below every strike or without a price", () => {
    expect(belowIndex(strikes(170, 180, 190), 18_000n)).toBe(1);
    expect(belowIndex(strikes(170, 180, 190), 18_500n)).toBe(1);
    expect(belowIndex(strikes(170, 180, 190), 16_000n)).toBe(-1);
    expect(belowIndex(strikes(170, 180, 190), 99_900n)).toBe(2);
    expect(belowIndex(strikes(170, 180, 190), null)).toBe(-1);
  });
});

describe("strikeWindow", () => {
  const nine = strikes(150, 160, 170, 180, 190, 200, 210, 220, 230);

  it("centres five strikes on the strike at or below live", () => {
    // live $185: $180 (index 3) is the middle row, the line sits under it.
    expect(strikeWindow(nine, 18_500n)).toEqual({ start: 1, end: 6, markerAfter: 2 });
  });

  it("clamps at the bottom and puts the line above the first row when live is below all", () => {
    expect(strikeWindow(nine, 10_000n)).toEqual({ start: 0, end: 5, markerAfter: -1 });
    expect(strikeWindow(nine, 15_500n)).toEqual({ start: 0, end: 5, markerAfter: 0 });
  });

  it("clamps at the top and puts the line under the last row when live is above all", () => {
    expect(strikeWindow(nine, 99_900n)).toEqual({ start: 4, end: 9, markerAfter: 4 });
  });

  it("shows the lowest strikes and no line without a live price", () => {
    expect(strikeWindow(nine, null)).toEqual({ start: 0, end: 5, markerAfter: null });
  });

  it("shows every strike when there are five or fewer, and nothing for none", () => {
    expect(strikeWindow(strikes(170, 180), 17_500n)).toEqual({ start: 0, end: 2, markerAfter: 0 });
    expect(strikeWindow([], 17_500n)).toEqual({ start: 0, end: 0, markerAfter: null });
  });

  it("always shows min(5, n) contiguous strikes, the live line between its bracketing strikes (property)", () => {
    const sortedStrikes = fc
      .uniqueArray(fc.integer({ min: 1, max: 100_000 }), { maxLength: 20 })
      .map((xs) => [...xs].sort((a, b) => a - b).map(BigInt));
    const live = fc.option(fc.integer({ min: 0, max: 110_000 }).map(BigInt), { nil: null });
    fc.assert(
      fc.property(sortedStrikes, live, (list, price) => {
        const { start, end, markerAfter } = strikeWindow(list, price);
        const width = Math.min(TILE_WINDOW, list.length);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(list.length);
        expect(end - start).toBe(width);
        if (price === null || list.length === 0) {
          expect(markerAfter).toBeNull();
          return;
        }
        // The live line is always inside the window.
        expect(markerAfter).not.toBeNull();
        const after = markerAfter ?? -2;
        if (after === -1) {
          expect(start).toBe(0);
          expect(price < (list[0] ?? 0n)).toBe(true);
        } else {
          const below = list[start + after] ?? 0n;
          const next = list[start + after + 1];
          expect(below <= price).toBe(true);
          if (next !== undefined) expect(price < next).toBe(true);
        }
        // Centred unless clamped: two strikes below the live strike when there is room.
        const live = belowIndex(list, price);
        if (list.length >= TILE_WINDOW && live >= 2 && live <= list.length - 3) {
          expect(live - start).toBe(2);
        }
      }),
    );
  });
});

describe("tileLadder", () => {
  it("windows the primary close set and counts every other open strike as hidden", () => {
    const today = [150, 160, 170, 180, 190, 200, 210].map((d) => cell(d));
    const tomorrow = [170, 180, 190].map((d) => cell(d, { closeTs: LATER_CLOSE }));
    const model = tileLadder(tile({ open: [...today, ...tomorrow], pythQuote: pyth(18_142) }));
    expect(model.rows.map((c) => c.market.strikeCents)).toEqual(strikes(160, 170, 180, 190, 200));
    expect(model.markerAfter).toBe(2);
    expect(model.hidden).toBe(5);
    expect(model.closeTs).toBe(CLOSE);
  });

  it("has no rows and no close time when nothing is open", () => {
    expect(tileLadder(tile())).toEqual({ rows: [], markerAfter: null, hidden: 0, closeTs: null });
  });
});

describe("tileStateText", () => {
  const closeAgo = (secs: number) => BigInt(NOW - secs);

  it("is null while a strike is open", () => {
    expect(tileStateText(tile({ open: [cell(180)] }), NOW)).toBeNull();
  });

  it("says the ticker has no markets when none are listed", () => {
    expect(tileStateText(tile(), NOW)).toBe("No markets today for NVDA");
  });

  it("says closed · settling for unsettled strikes, and delayed past the window", () => {
    expect(tileStateText(tile({ closed: [cell(180, { closeTs: closeAgo(60) })] }), NOW)).toBe(
      "Closed · settling",
    );
    expect(
      tileStateText(
        tile({
          closed: [cell(180, { closeTs: closeAgo(60) }), cell(190, { closeTs: closeAgo(3_600) })],
        }),
        NOW,
      ),
    ).toBe("Settlement delayed");
  });

  it("says markets closed when every strike settled", () => {
    expect(tileStateText(tile({ closed: [cell(180, { settled: true })] }), NOW)).toBe(
      "Markets closed",
    );
  });
});
