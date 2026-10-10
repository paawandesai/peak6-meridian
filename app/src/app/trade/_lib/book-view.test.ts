import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { derivedNoLine, levelsOf, makersFor, noView, ownOrders, spreadOf } from "./book-view";
import { BOOK, key, MAKER_A, MAKER_B, order, USER } from "./test-support";

describe("levelsOf", () => {
  it("aggregates by price, bids highest first and asks lowest first", () => {
    const levels = levelsOf({
      bids: [order("bid", 57, 5), order("bid", 58, 3), order("bid", 58, 4)],
      asks: [order("ask", 62, 1), order("ask", 61, 2), order("ask", 61, 6)],
    });
    expect(levels.bids).toEqual([
      { price: 58, qty: 7n },
      { price: 57, qty: 5n },
    ]);
    expect(levels.asks).toEqual([
      { price: 61, qty: 8n },
      { price: 62, qty: 1n },
    ]);
  });

  it("ignores empty slots", () => {
    expect(levelsOf({ bids: [order("bid", 50, 0)], asks: [] })).toEqual({ bids: [], asks: [] });
  });
});

describe("noView (AC4)", () => {
  it("shows YES asks as NO bids at 100 − p and YES bids as NO asks at 100 − p", () => {
    const no = noView(levelsOf(BOOK));
    expect(no.bids).toEqual([
      { price: 39, qty: 40n }, // YES ask 61
      { price: 38, qty: 25n }, // YES ask 62
    ]);
    expect(no.asks).toEqual([
      { price: 42, qty: 30n }, // YES bid 58
      { price: 43, qty: 50n }, // YES bid 57
    ]);
  });

  it("is its own inverse (property)", () => {
    const price = fc.integer({ min: 1, max: 99 });
    const levels = fc.array(fc.record({ price, qty: fc.bigInt({ min: 1n, max: 1000n }) }), {
      maxLength: 6,
    });
    fc.assert(
      fc.property(levels, levels, (bids, asks) => {
        const book = { bids, asks };
        expect(noView(noView(book))).toEqual(book);
      }),
    );
  });
});

describe("spreadOf", () => {
  it("reports spread and the integer-floor mid", () => {
    expect(spreadOf(levelsOf(BOOK))).toEqual({ bestBid: 58, bestAsk: 61, spread: 3, mid: 59 });
  });

  it("has no spread when a side is empty or the book is crossed", () => {
    expect(spreadOf({ bids: [], asks: [{ price: 61, qty: 1n }] })).toMatchObject({
      spread: null,
      mid: null,
    });
    expect(
      spreadOf({ bids: [{ price: 70, qty: 1n }], asks: [{ price: 60, qty: 1n }] }),
    ).toMatchObject({ spread: null, mid: null });
  });
});

describe("derivedNoLine (AC9)", () => {
  it("is a template over the live YES price", () => {
    expect(derivedNoLine(58)).toBe("NO 42¢ = 100 − 58¢ YES; YES + NO = 100¢");
    expect(derivedNoLine(70)).toBe("NO 30¢ = 100 − 70¢ YES; YES + NO = 100¢");
  });

  it("states the rule alone when there is no price", () => {
    expect(derivedNoLine(null)).toBe("NO = 100 − YES; YES + NO = 100¢");
  });
});

describe("makersFor", () => {
  const user = USER.toBase58();

  it("names the owners of the asks a Buy YES at the price can cross", () => {
    expect(makersFor("BUY_YES", 61, BOOK, user)).toEqual([MAKER_A.toBase58()]);
    expect(makersFor("BUY_YES", 99, BOOK, user)).toEqual([MAKER_A.toBase58(), MAKER_B.toBase58()]);
    expect(makersFor("BUY_YES", 60, BOOK, user)).toEqual([]);
  });

  it("uses bids for the sales of YES and asks for Sell NO", () => {
    expect(makersFor("SELL_YES", 58, BOOK, user)).toEqual([MAKER_A.toBase58()]);
    expect(makersFor("BUY_NO", 1, BOOK, user)).toEqual([MAKER_A.toBase58(), MAKER_B.toBase58()]);
    expect(makersFor("SELL_NO", 99, BOOK, user)).toEqual([MAKER_A.toBase58(), MAKER_B.toBase58()]);
  });

  it("never names the taker, and lists each owner once, in price-time order", () => {
    const book = {
      bids: [],
      asks: [
        order("ask", 62, 1, MAKER_B, 5),
        order("ask", 61, 1, USER, 1),
        order("ask", 61, 1, MAKER_A, 2),
        order("ask", 61, 1, MAKER_B, 3),
        order("ask", 62, 1, MAKER_A, 4),
      ],
    };
    expect(makersFor("BUY_YES", 99, book, user)).toEqual([MAKER_A.toBase58(), MAKER_B.toBase58()]);
  });

  it("looks only at the first 8 crossing orders", () => {
    const owners = Array.from({ length: 10 }, (_, i) => key(20 + i));
    const asks = owners.map((owner, i) => order("ask", 50, 1, owner, i + 1));
    const book = { bids: [], asks };
    expect(makersFor("BUY_YES", 99, book, user)).toEqual(
      owners.slice(0, 8).map((o) => o.toBase58()),
    );
  });
});

describe("ownOrders", () => {
  it("lists the wallet's resting orders on both sides", () => {
    const book = {
      bids: [order("bid", 50, 2, USER, 1), order("bid", 49, 2, MAKER_A, 2)],
      asks: [order("ask", 70, 3, USER, 3)],
    };
    expect(ownOrders(book, USER.toBase58()).map((o) => [o.side, o.price])).toEqual([
      ["Bid", 50],
      ["Ask", 70],
    ]);
  });
});
