/**
 * P0-7: the YES/NO toggle shows one book mirrored at 100 − p, and a fill highlights the same level
 * in both views. Pure transforms, property-tested.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type BookLevels,
  changedLevels,
  depthPercent,
  displayedYesOfLevels,
  type Level,
  levelKey,
  levelsOf,
  noView,
  yesKeyOfNoRow,
} from "./book-view";
import { BOOK } from "./test-support";

const levelsArb = (sort: (a: number, b: number) => number) =>
  fc
    .uniqueArray(
      fc.record({
        price: fc.integer({ min: 1, max: 99 }),
        qty: fc.bigInt({ min: 1n, max: 10n ** 9n }),
      }),
      { selector: (level) => level.price, maxLength: 12 },
    )
    .map((levels): Level[] => [...levels].sort((a, b) => sort(a.price, b.price)));

const bookArb: fc.Arbitrary<BookLevels> = fc.record({
  bids: levelsArb((a, b) => b - a),
  asks: levelsArb((a, b) => a - b),
});

describe("noView mirror (P0-7 AC1)", () => {
  it("every YES level appears in the NO view at 100 − p with the same quantity, and back", () => {
    fc.assert(
      fc.property(bookArb, (yes) => {
        const no = noView(yes);
        expect(no.bids.map((l) => [100 - l.price, l.qty])).toEqual(
          yes.asks.map((l) => [l.price, l.qty]),
        );
        expect(no.asks.map((l) => [100 - l.price, l.qty])).toEqual(
          yes.bids.map((l) => [l.price, l.qty]),
        );
        expect(noView(no)).toEqual(yes);
      }),
    );
  });

  it("YES + NO = 100¢ at every mirrored level", () => {
    const yes = levelsOf(BOOK);
    const no = noView(yes);
    no.bids.forEach((level, i) => expect(level.price + (yes.asks[i]?.price ?? NaN)).toBe(100));
    no.asks.forEach((level, i) => expect(level.price + (yes.bids[i]?.price ?? NaN)).toBe(100));
  });
});

describe("changedLevels (P0-7 AC2)", () => {
  it("is empty for the same book", () => {
    fc.assert(
      fc.property(bookArb, (book) => {
        expect(changedLevels(book, book)).toEqual([]);
      }),
    );
  });

  it("names a resized, a removed and a new level in YES terms", () => {
    const before = levelsOf(BOOK); // bids 58×30, 57×50 · asks 61×40, 62×25
    const after: BookLevels = {
      bids: [
        { price: 58, qty: 20n },
        { price: 57, qty: 50n },
      ],
      asks: [
        { price: 60, qty: 5n },
        { price: 61, qty: 40n },
      ],
    };
    expect(changedLevels(before, after)).toEqual(["ask:60", "ask:62", "bid:58"]);
  });

  it("a changed YES level maps to exactly the NO row that relabels it", () => {
    fc.assert(
      fc.property(bookArb, bookArb, (before, after) => {
        const changed = new Set(changedLevels(before, after));
        const no = noView(after);
        const noRows = [
          ...no.bids.map((l) => yesKeyOfNoRow("bid", l.price)),
          ...no.asks.map((l) => yesKeyOfNoRow("ask", l.price)),
        ];
        const yesRows = [
          ...after.asks.map((l) => levelKey("ask", l.price)),
          ...after.bids.map((l) => levelKey("bid", l.price)),
        ];
        // Same set of highlighted rows whichever view is shown.
        expect(new Set(noRows.filter((k) => changed.has(k)))).toEqual(
          new Set(yesRows.filter((k) => changed.has(k))),
        );
      }),
    );
  });

  it("maps a NO bid to the YES ask at 100 − p and a NO ask to the YES bid", () => {
    expect(yesKeyOfNoRow("bid", 39)).toBe("ask:61");
    expect(yesKeyOfNoRow("ask", 42)).toBe("bid:58");
  });
});

describe("depthPercent", () => {
  it("is a whole percent of the largest level, 0 for empty input", () => {
    expect(depthPercent(25n, 50n)).toBe(50);
    expect(depthPercent(50n, 50n)).toBe(100);
    expect(depthPercent(0n, 50n)).toBe(0);
    expect(depthPercent(5n, 0n)).toBe(0);
  });

  it("stays within 0–100 for any quantities", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -5n, max: 10n ** 12n }),
        fc.bigInt({ min: -5n, max: 10n ** 12n }),
        (q, m) => {
          const pct = depthPercent(q, m);
          expect(Number.isInteger(pct)).toBe(true);
          expect(pct).toBeGreaterThanOrEqual(0);
          expect(pct).toBeLessThanOrEqual(100);
        },
      ),
    );
  });
});

describe("displayedYesOfLevels", () => {
  it("is the floor mid for a spread of at most 10¢", () => {
    expect(displayedYesOfLevels(levelsOf(BOOK))).toBe(59);
    expect(
      displayedYesOfLevels({ bids: [{ price: 50, qty: 1n }], asks: [{ price: 60, qty: 1n }] }),
    ).toBe(55);
  });

  it("is null for a wide, one-sided or empty book", () => {
    expect(
      displayedYesOfLevels({ bids: [{ price: 50, qty: 1n }], asks: [{ price: 61, qty: 1n }] }),
    ).toBeNull();
    expect(displayedYesOfLevels({ bids: [{ price: 50, qty: 1n }], asks: [] })).toBeNull();
    expect(displayedYesOfLevels({ bids: [], asks: [] })).toBeNull();
  });
});
