import fc from "fast-check";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import type { OpenOrdersRow, RestingOrder } from "./data";
import { AAPL, MSFT, NVDA } from "./fixtures";
import { bidEscrow, buildMmBlock, formatSignedQty, sides } from "./mm";
import type { MarketRow } from "@/lib/markets";

const CENT = 10_000n;
const MARKETS = [NVDA, AAPL, MSFT];

const order = (
  market: MarketRow,
  side: "Bid" | "Ask",
  price: number,
  qty: bigint,
  orderId = 1n,
): RestingOrder => ({ market: market.address, orderId, side, price, qty });

const oo = (market: MarketRow, o: Partial<OpenOrdersRow> = {}): OpenOrdersRow => ({
  market: market.address,
  freeUsdc: 0n,
  freeYes: 0n,
  restingCount: 0,
  ...o,
});

describe("buildMmBlock", () => {
  it("is empty for a wallet with no OpenOrders accounts", () => {
    const mm = buildMmBlock({
      markets: MARKETS,
      openOrders: [],
      resting: [],
      netByMarket: new Map(),
    });
    expect(mm).toEqual({
      strikes: [],
      openOrders: 0,
      bidQty: 0n,
      askQty: 0n,
      escrowUsdc: 0n,
      unsettledUsdc: 0n,
      unsettledYes: 0n,
      withdrawable: [],
    });
  });

  it("leaves out an OpenOrders account with nothing resting and nothing owed", () => {
    const mm = buildMmBlock({
      markets: MARKETS,
      openOrders: [oo(NVDA)],
      resting: [],
      netByMarket: new Map([[NVDA.address, 4n]]),
    });
    expect(mm.strikes).toEqual([]);
  });

  it("leaves out an OpenOrders account for a market that is not listed (e.g. hidden test market)", () => {
    const hidden = PublicKey.unique().toBase58();
    const mm = buildMmBlock({
      markets: MARKETS,
      openOrders: [{ market: hidden, freeUsdc: 9n, freeYes: 0n, restingCount: 1 }],
      resting: [{ market: hidden, orderId: 1n, side: "Bid", price: 10, qty: 1n }],
      netByMarket: new Map(),
    });
    expect(mm.strikes).toEqual([]);
    expect(mm.withdrawable).toEqual([]);
  });

  it("aggregates bids and asks per strike with best prices, fill scenarios and escrow", () => {
    const mm = buildMmBlock({
      markets: MARKETS,
      openOrders: [oo(NVDA, { restingCount: 3, freeUsdc: 250_000n, freeYes: 2n })],
      resting: [
        order(NVDA, "Bid", 55, 10n, 1n),
        order(NVDA, "Bid", 57, 5n, 2n),
        order(NVDA, "Ask", 62, 8n, 3n),
      ],
      netByMarket: new Map([[NVDA.address, -10n]]),
    });
    expect(mm.strikes).toEqual([
      {
        market: NVDA,
        net: -10n,
        resting: 3,
        bids: { count: 2, qty: 15n, best: 57 },
        asks: { count: 1, qty: 8n, best: 62 },
        netIfBidsFill: 5n,
        netIfAsksFill: -18n,
        escrowUsdc: (55n * 10n + 57n * 5n) * CENT,
        escrowYes: 8n,
        freeUsdc: 250_000n,
        freeYes: 2n,
        mismatch: false,
      },
    ]);
    expect(mm).toMatchObject({ openOrders: 3, bidQty: 15n, askQty: 8n, unsettledYes: 2n });
  });

  it("sorts strikes by ticker, newest date, then strike", () => {
    const mm = buildMmBlock({
      markets: MARKETS,
      openOrders: [
        oo(NVDA, { freeUsdc: 1n }),
        oo(MSFT, { freeUsdc: 1n }),
        oo(AAPL, { freeUsdc: 1n }),
      ],
      resting: [],
      netByMarket: new Map(),
    });
    expect(mm.strikes.map((strike) => strike.market.ticker)).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("flags a strike whose book orders differ from resting_count", () => {
    const mm = buildMmBlock({
      markets: MARKETS,
      openOrders: [oo(NVDA, { restingCount: 2 })],
      resting: [order(NVDA, "Ask", 60, 1n)],
      netByMarket: new Map(),
    });
    expect(mm.strikes[0]?.mismatch).toBe(true);
  });
});

describe("sides and bidEscrow", () => {
  it("an empty list has no best price and no escrow", () => {
    expect(sides([])).toEqual({
      bids: { count: 0, qty: 0n, best: null },
      asks: { count: 0, qty: 0n, best: null },
    });
    expect(bidEscrow([])).toBe(0n);
  });
  it("asks escrow YES, not USDC", () => {
    expect(bidEscrow([order(NVDA, "Ask", 99, 1_000n)])).toBe(0n);
  });
});

describe("formatSignedQty", () => {
  it("signs with + and U+2212", () => {
    expect(formatSignedQty(25n)).toBe("+25");
    expect(formatSignedQty(-10n)).toBe("−10");
    expect(formatSignedQty(0n)).toBe("0");
  });
  it("round-trips any integer (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), (value) => {
        const text = formatSignedQty(value);
        expect(BigInt(text.replace("+", "").replace("−", "-"))).toBe(value);
      }),
    );
  });
});

// ---- properties: the block's numbers are exact functions of the on-chain orders ----

const marketArb = fc.constantFrom(...MARKETS);
const orderArb = fc.record({
  market: marketArb,
  side: fc.constantFrom<"Bid" | "Ask">("Bid", "Ask"),
  price: fc.integer({ min: 1, max: 99 }),
  qty: fc.bigInt({ min: 1n, max: 1_000_000n }),
});
const ooArb = fc.record({
  freeUsdc: fc.bigInt({ min: 0n, max: 10n ** 12n }),
  freeYes: fc.bigInt({ min: 0n, max: 10n ** 6n }),
});
const netArb = fc.bigInt({ min: -(10n ** 6n), max: 10n ** 6n });

describe("buildMmBlock properties", () => {
  it("per-strike and total figures equal sums over the resting orders and OpenOrders rows", () => {
    fc.assert(
      fc.property(
        fc.array(orderArb, { maxLength: 40 }),
        fc.tuple(ooArb, ooArb, ooArb),
        fc.tuple(netArb, netArb, netArb),
        (rawOrders, free, nets) => {
          const resting = rawOrders.map((o, index) =>
            order(o.market, o.side, o.price, o.qty, BigInt(index)),
          );
          const openOrders = MARKETS.map((market, index) =>
            oo(market, {
              ...free[index],
              restingCount: resting.filter((o) => o.market === market.address).length,
            }),
          );
          const netByMarket = new Map(
            MARKETS.map((market, index) => [market.address, nets[index] ?? 0n]),
          );
          const mm = buildMmBlock({ markets: MARKETS, openOrders, resting, netByMarket });

          for (const strike of mm.strikes) {
            const mine = resting.filter((o) => o.market === strike.market.address);
            const bids = mine.filter((o) => o.side === "Bid");
            const asks = mine.filter((o) => o.side === "Ask");
            const total = (list: RestingOrder[]) => list.reduce((s, o) => s + o.qty, 0n);
            expect(strike.mismatch).toBe(false);
            expect(strike.bids.count + strike.asks.count).toBe(mine.length);
            expect(strike.bids.qty).toBe(total(bids));
            expect(strike.asks.qty).toBe(total(asks));
            expect(strike.bids.best).toBe(
              bids.length ? Math.max(...bids.map((o) => o.price)) : null,
            );
            expect(strike.asks.best).toBe(
              asks.length ? Math.min(...asks.map((o) => o.price)) : null,
            );
            expect(strike.escrowUsdc).toBe(
              bids.reduce((s, o) => s + BigInt(o.price) * CENT * o.qty, 0n),
            );
            expect(strike.netIfBidsFill - strike.net).toBe(strike.bids.qty);
            expect(strike.net - strike.netIfAsksFill).toBe(strike.asks.qty);
          }
          // Every market with an order or a balance is listed exactly once.
          const active = openOrders.filter(
            (row) => row.restingCount > 0 || row.freeUsdc > 0n || row.freeYes > 0n,
          );
          expect(mm.strikes).toHaveLength(active.length);
          expect(mm.openOrders).toBe(resting.length);
          expect(mm.bidQty + mm.askQty).toBe(resting.reduce((s, o) => s + o.qty, 0n));
          expect(mm.escrowUsdc).toBe(bidEscrow(resting));
          expect(mm.unsettledUsdc).toBe(openOrders.reduce((s, row) => s + row.freeUsdc, 0n));
          expect(mm.unsettledYes).toBe(openOrders.reduce((s, row) => s + row.freeYes, 0n));
          expect(mm.withdrawable).toHaveLength(
            openOrders.filter((row) => row.freeUsdc > 0n || row.freeYes > 0n).length,
          );
        },
      ),
    );
  });
});
