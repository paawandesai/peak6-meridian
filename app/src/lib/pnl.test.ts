import { formatPriceTenths, formatUsdSigned } from "@meridian/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { MeridianEvent } from "./events";
import {
  applyTrade,
  EMPTY_POSITION,
  ifRightPays,
  ledger,
  markTenths,
  positionKey,
  type Trade,
  tradesFromEvents,
  unrealized,
  yesMarkTenths,
} from "./pnl";

const W = "Wallet1111111111111111111111111111111111111";
const OTHER = "Other11111111111111111111111111111111111111";
const M = "Mkt1111111111111111111111111111111111111111";
const CENT = 10_000n;

let counter = 0;
const base = (signature: string) => ({ signature, blockTime: 1_700_000_000 + counter++ });
const fill = (
  signature: string,
  o: { taker: string; maker: string; takerSide: "Bid" | "Ask"; price: number; qty: bigint },
): MeridianEvent => ({ ...base(signature), kind: "Fill", market: M, ...o });
const mint = (signature: string, qty: bigint): MeridianEvent => ({
  ...base(signature),
  kind: "PairsMinted",
  market: M,
  user: W,
  qty,
  pairsOutstanding: qty,
});
const redeem = (signature: string, yesQty: bigint, noQty: bigint, usdc: bigint): MeridianEvent => ({
  ...base(signature),
  kind: "Redeemed",
  market: M,
  user: W,
  yesQty,
  noQty,
  usdc,
});

const yes = (trades: readonly Trade[]) => ledger(trades).get(positionKey(M, "YES"));
const no = (trades: readonly Trade[]) => ledger(trades).get(positionKey(M, "NO"));

describe("average-cost accounting", () => {
  it("buys add quantity and cost; a partial sell realizes against the average", () => {
    let p = applyTrade(EMPTY_POSITION, {
      market: M,
      side: "YES",
      dir: "buy",
      qty: 10n,
      unit: 40n * CENT,
    });
    p = applyTrade(p, { market: M, side: "YES", dir: "buy", qty: 10n, unit: 50n * CENT });
    expect(p).toMatchObject({ qty: 20n, cost: 20n * 45n * CENT });
    p = applyTrade(p, { market: M, side: "YES", dir: "sell", qty: 5n, unit: 60n * CENT });
    // 5 sold at 60¢ against a 45¢ average: +75¢ × 5 = $0.75.
    expect(p.realized).toBe(5n * 15n * CENT);
    expect(p.qty).toBe(15n);
    expect(p.cost).toBe(15n * 45n * CENT);
  });

  it("selling more than is held clamps and records the shortfall", () => {
    const p = applyTrade(
      applyTrade(EMPTY_POSITION, { market: M, side: "NO", dir: "buy", qty: 2n, unit: 30n * CENT }),
      { market: M, side: "NO", dir: "sell", qty: 5n, unit: 50n * CENT },
    );
    expect(p).toMatchObject({ qty: 0n, cost: 0n, shortfall: 3n, realized: 2n * 20n * CENT });
  });

  it("ignores zero-quantity trades", () => {
    const p = applyTrade(EMPTY_POSITION, { market: M, side: "YES", dir: "buy", qty: 0n, unit: 1n });
    expect(p).toBe(EMPTY_POSITION);
  });

  it("a non-whole average cost and a fractional-cent loss print exactly (AC1b)", () => {
    // 3 at 41¢ and 4 at 42¢: total 291¢ over 7 = 41.571…¢ → floor to 41.5¢.
    const p = ledger([
      { market: M, side: "YES", dir: "buy", qty: 3n, unit: 41n * CENT },
      { market: M, side: "YES", dir: "buy", qty: 4n, unit: 42n * CENT },
    ]).get(positionKey(M, "YES"));
    expect(p).toBeDefined();
    expect(formatPriceTenths(p?.cost ?? 0n, p?.qty ?? 1n)).toBe("41.5¢");
    // A half-cent mid: bid 58¢, ask 61¢ → 59.5¢.
    const mark = yesMarkTenths({
      outcome: "None",
      quotes: { yesBid: 58, yesAsk: 61 },
      lastYesCents: undefined,
    });
    expect(mark).toBe(595n);
    expect(formatPriceTenths((mark ?? 0n) * 1_000n)).toBe("59.5¢");
    // Fractional-cent loss: 1 contract bought at 60¢, marked 59.5¢ → −$0.005 floors to −$0.01.
    const loss = unrealized(595n, 1n, 60n * CENT);
    expect(loss).toBe(-5_000n);
    expect(formatUsdSigned(loss ?? 0n, "always")).toBe("−$0.01");
  });
});

describe("tradesFromEvents", () => {
  it("a plain taker buy and a maker sale are YES trades at the fill price", () => {
    const { trades, lastYesCents } = tradesFromEvents(
      [
        fill("a", { taker: W, maker: OTHER, takerSide: "Bid", price: 40, qty: 10n }),
        fill("b", { taker: OTHER, maker: W, takerSide: "Bid", price: 55, qty: 4n }),
      ],
      W,
    );
    expect(yes(trades)).toMatchObject({
      qty: 6n,
      cost: 6n * 40n * CENT,
      realized: 4n * 15n * CENT,
    });
    expect(lastYesCents[M]).toBe(55);
  });

  it("Buy NO (mint + sell YES at p) is NO bought at 100 − p with no YES left", () => {
    const { trades } = tradesFromEvents(
      [
        mint("t", 10n),
        fill("t", { taker: W, maker: OTHER, takerSide: "Ask", price: 58, qty: 10n }),
      ],
      W,
    );
    expect(no(trades)).toMatchObject({ qty: 10n, cost: 10n * 42n * CENT });
    expect(yes(trades)).toBeUndefined();
  });

  it("Sell NO (buy YES at p + pair redeem) is NO sold at 100 − p", () => {
    const { trades } = tradesFromEvents(
      [
        mint("m", 10n),
        fill("m", { taker: W, maker: OTHER, takerSide: "Ask", price: 58, qty: 10n }),
        fill("s", { taker: W, maker: OTHER, takerSide: "Bid", price: 50, qty: 10n }),
        redeem("s", 10n, 10n, 10_000_000n),
      ],
      W,
    );
    // Bought NO at 42¢, sold it at 50¢: +8¢ × 10.
    expect(no(trades)).toMatchObject({ qty: 0n, realized: 10n * 8n * CENT });
  });

  it("a pair minted alone books 50¢ a side; a partial Buy NO leaves the rest at 50¢", () => {
    const alone = tradesFromEvents([mint("p", 5n)], W).trades;
    expect(yes(alone)).toMatchObject({ qty: 5n, cost: 5n * 50n * CENT });
    expect(no(alone)).toMatchObject({ qty: 5n, cost: 5n * 50n * CENT });
    const partial = tradesFromEvents(
      [mint("q", 10n), fill("q", { taker: W, maker: OTHER, takerSide: "Ask", price: 60, qty: 4n })],
      W,
    ).trades;
    expect(no(partial)).toMatchObject({ qty: 10n, cost: 4n * 40n * CENT + 6n * 50n * CENT });
    expect(yes(partial)).toMatchObject({ qty: 6n });
  });

  it("a winner redeem pays the winning side $1.00 and the losing side $0.00", () => {
    const events = [mint("a", 10n), redeem("r", 10n, 4n, 10_000_000n)];
    const won = tradesFromEvents(events, W, { [M]: "Yes" }).trades;
    expect(yes(won)).toMatchObject({ qty: 0n, realized: 10n * 50n * CENT });
    expect(no(won)).toMatchObject({ qty: 6n, realized: -(4n * 50n * CENT) });
    const lost = tradesFromEvents(events, W, { [M]: "No" }).trades;
    expect(no(lost)?.realized).toBe(4n * 50n * CENT);
    expect(yes(lost)?.realized).toBe(-(10n * 50n * CENT));
  });

  it("an unequal redeem on an unsettled market is skipped and counted", () => {
    const result = tradesFromEvents([redeem("x", 3n, 1n, 0n)], W, {});
    expect(result.skipped).toBe(1);
    expect(result.trades).toHaveLength(0);
  });

  it("ignores events of other wallets and non-trade events", () => {
    const { trades } = tradesFromEvents(
      [
        fill("a", { taker: OTHER, maker: OTHER, takerSide: "Bid", price: 40, qty: 10n }),
        { ...base("z"), kind: "OrderCancelled", market: M, owner: W, orderId: 1n, qty: 1n },
      ],
      W,
    );
    expect(trades).toHaveLength(0);
  });
});

describe("marks and payouts", () => {
  it("falls back from the mid to the last trade to nothing", () => {
    expect(
      yesMarkTenths({ outcome: "None", quotes: { yesBid: 58, yesAsk: null }, lastYesCents: 57 }),
    ).toBe(570n);
    expect(yesMarkTenths({ outcome: "None", quotes: null, lastYesCents: undefined })).toBeNull();
    expect(yesMarkTenths({ outcome: "Yes", quotes: null, lastYesCents: undefined })).toBe(1000n);
    expect(yesMarkTenths({ outcome: "No", quotes: null, lastYesCents: 80 })).toBe(0n);
  });

  it("NO is 100¢ less YES; payouts are $1.00 a contract", () => {
    expect(markTenths("NO", 595n)).toBe(405n);
    expect(markTenths("YES", 595n)).toBe(595n);
    expect(markTenths("NO", null)).toBeNull();
    expect(ifRightPays(40n)).toBe(40_000_000n);
    expect(unrealized(null, 5n, 10n)).toBeNull();
  });
});

// --- AC1: property test against an independent ledger -----------------------------------------

/**
 * An independent model of average-cost accounting: per-contract lots held as exact rationals
 * (numerator over denominator), consumed pro rata. No shared code with `applyTrade`.
 */
class RationalBook {
  private qty = 0n;
  // Average cost per contract as a fraction cost / qty, kept as total cost over the quantity.
  private costNum = 0n;
  private costDen = 1n;
  realizedNum = 0n;
  realizedDen = 1n;

  buy(qty: bigint, unit: bigint): void {
    // total cost = costNum/costDen + qty*unit
    this.costNum = this.costNum + qty * unit * this.costDen;
    this.qty += qty;
  }

  sell(qty: bigint, unit: bigint): void {
    const sold = qty < this.qty ? qty : this.qty;
    if (sold === 0n) return;
    // cost removed = total cost × sold / qty (exact rational)
    const removedNum = this.costNum * sold;
    const removedDen = this.costDen * this.qty;
    // realized += sold*unit − removed
    const gainNum = sold * unit * removedDen - removedNum;
    const gainDen = removedDen;
    this.realizedNum = this.realizedNum * gainDen + gainNum * this.realizedDen;
    this.realizedDen = this.realizedDen * gainDen;
    // remaining cost = total × (qty − sold) / qty
    this.costNum = this.costNum * (this.qty - sold);
    this.costDen = this.costDen * this.qty;
    this.qty -= sold;
    if (this.qty === 0n) {
      this.costNum = 0n;
      this.costDen = 1n;
    }
  }

  /** realized in base units, floored toward −∞, and the exact remaining cost likewise. */
  realized(): bigint {
    return floorDiv(this.realizedNum, this.realizedDen);
  }
  cost(): bigint {
    return floorDiv(this.costNum, this.costDen);
  }
  held(): bigint {
    return this.qty;
  }
}

function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

describe("AC1: realized and held cost match an independent rational ledger", () => {
  const step = fc.record({
    dir: fc.constantFrom("buy", "sell"),
    qty: fc.integer({ min: 1, max: 50 }),
    cents: fc.integer({ min: 1, max: 99 }),
  });

  it("agrees within one base unit per exit, and conserves cost exactly", () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 60 }), (steps) => {
        const model = new RationalBook();
        let position = EMPTY_POSITION;
        let exits = 0n;
        let totalIn = 0n;
        let totalOut = 0n;
        for (const s of steps) {
          const qty = BigInt(s.qty);
          const unit = BigInt(s.cents) * CENT;
          const sold = s.dir === "sell" ? (qty < position.qty ? qty : position.qty) : 0n;
          if (s.dir === "buy") {
            model.buy(qty, unit);
            totalIn += qty * unit;
          } else {
            model.sell(qty, unit);
            if (sold > 0n) exits += 1n;
            totalOut += sold * unit;
          }
          position = applyTrade(position, {
            market: M,
            side: "YES",
            dir: s.dir as "buy" | "sell",
            qty,
            unit,
          });
          expect(position.qty).toBe(model.held());
        }
        const drift = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
        expect(drift(position.realized, model.realized()) <= exits + 1n).toBe(true);
        expect(drift(position.cost, model.cost()) <= exits + 1n).toBe(true);
        // Exact conservation: proceeds − realized = cost removed; cost in = removed + held cost.
        expect(totalIn - (totalOut - position.realized) === position.cost).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("a scripted fill sequence matches hand-computed figures", () => {
    const { trades } = tradesFromEvents(
      [
        fill("1", { taker: W, maker: OTHER, takerSide: "Bid", price: 40, qty: 10n }),
        fill("2", { taker: W, maker: OTHER, takerSide: "Bid", price: 50, qty: 10n }),
        fill("3", { taker: W, maker: OTHER, takerSide: "Ask", price: 60, qty: 5n }),
        fill("4", { taker: W, maker: OTHER, takerSide: "Ask", price: 30, qty: 15n }),
      ],
      W,
    );
    const p = yes(trades);
    // Avg 45¢; first sale: 5 × (60−45) = +75¢; second: 15 × (30−45) = −225¢; flat → realized −150¢.
    expect(p).toMatchObject({ qty: 0n, cost: 0n, realized: -150n * CENT });
  });
});
