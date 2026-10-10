import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { levelsOf } from "./book-view";
import {
  allowsLimit,
  defaultWorstPrice,
  INTENT_LABEL,
  INTENT_ORDER,
  intentSubLabel,
  MAX_ORDER_QTY,
  parseOrder,
  signLabel,
  sideOf,
  startingPrice,
} from "./intents";
import { BOOK } from "./test-support";

describe("intents", () => {
  it("lists the four intents in domain order with equal labels", () => {
    expect(INTENT_ORDER.map((intent) => INTENT_LABEL[intent])).toEqual([
      "Buy YES",
      "Buy NO",
      "Sell YES",
      "Sell NO",
    ]);
  });

  it("states the outcome in each sub-label", () => {
    expect(INTENT_ORDER.map((intent) => intentSubLabel(intent, "$180"))).toEqual([
      "wins if ≥ $180",
      "wins if < $180",
      "exit YES",
      "exit NO",
    ]);
  });

  it("names the sign button after the intent and the side after the token", () => {
    expect(signLabel("BUY_NO")).toBe("Sign and buy NO");
    expect(sideOf("SELL_YES")).toBe("YES");
    expect(sideOf("BUY_NO")).toBe("NO");
  });

  it("defaults a market order's worst price to 99 to buy and 1 to sell", () => {
    expect(defaultWorstPrice("BUY_YES")).toBe(99);
    expect(defaultWorstPrice("BUY_NO")).toBe(99);
    expect(defaultWorstPrice("SELL_YES")).toBe(1);
    expect(defaultWorstPrice("SELL_NO")).toBe(1);
  });

  it("allows a limit for everything but Sell NO", () => {
    expect(allowsLimit("SELL_NO")).toBe(false);
    expect(allowsLimit("BUY_NO")).toBe(true);
  });
});

describe("parseOrder", () => {
  const ok = { kind: "limit", priceText: "40", qtyText: "10" } as const;

  it("accepts whole contracts and whole-cent prices", () => {
    expect(parseOrder("BUY_NO", ok)).toEqual({ ok: true, kind: "limit", priceCents: 40, qty: 10n });
  });

  it("turns a market order into an IOC at the worst price", () => {
    expect(parseOrder("BUY_YES", { ...ok, kind: "market" })).toMatchObject({ kind: "ioc" });
  });

  it("forces Sell NO to IOC even when limit is asked for", () => {
    expect(parseOrder("SELL_NO", ok)).toMatchObject({ ok: true, kind: "ioc" });
  });

  it.each(["", "0", "-1", "1.5", "1e3", "abc", " ", "1,000", "0x10"])(
    "rejects quantity %j",
    (qtyText) => {
      expect(parseOrder("BUY_YES", { ...ok, qtyText }).ok).toBe(false);
    },
  );

  it("rejects more than the maximum quantity", () => {
    expect(parseOrder("BUY_YES", { ...ok, qtyText: (MAX_ORDER_QTY + 1n).toString() }).ok).toBe(
      false,
    );
    expect(parseOrder("BUY_YES", { ...ok, qtyText: MAX_ORDER_QTY.toString() }).ok).toBe(true);
  });

  it.each(["", "0", "100", "-5", "50.5", "5 0", "abc"])("rejects price %j", (priceText) => {
    const result = parseOrder("BUY_YES", { ...ok, priceText });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/1 to 99/);
  });

  it("round-trips any valid price and quantity (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.bigInt({ min: 1n, max: MAX_ORDER_QTY }),
        (price, qty) => {
          const result = parseOrder("SELL_YES", {
            kind: "limit",
            priceText: String(price),
            qtyText: qty.toString(),
          });
          expect(result).toEqual({ ok: true, kind: "limit", priceCents: price, qty });
        },
      ),
    );
  });

  it("never accepts a price outside 1-99 (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 999 }), (price) => {
        expect(parseOrder("BUY_YES", { ...ok, priceText: String(price) }).ok).toBe(false);
      }),
    );
  });
});

describe("startingPrice", () => {
  const levels = levelsOf(BOOK); // bids 58, 57 · asks 61, 62

  it("crosses the best opposite order in the intent's own terms", () => {
    expect(startingPrice("BUY_YES", "limit", levels)).toBe(61);
    expect(startingPrice("SELL_YES", "limit", levels)).toBe(58);
    expect(startingPrice("BUY_NO", "limit", levels)).toBe(42); // 100 − best bid 58
    expect(startingPrice("SELL_NO", "market", levels)).toBe(1);
  });

  it("falls back to 50 on an empty side and to the worst price for market orders", () => {
    const empty = { bids: [], asks: [] };
    expect(startingPrice("BUY_YES", "limit", empty)).toBe(50);
    expect(startingPrice("SELL_YES", "limit", empty)).toBe(50);
    expect(startingPrice("BUY_NO", "limit", empty)).toBe(50);
    expect(startingPrice("BUY_YES", "market", levels)).toBe(99);
  });
});
