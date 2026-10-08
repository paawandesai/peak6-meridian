import { describe, expect, it } from "vitest";

import { AAPL, fill, MSFT, NVDA, OTHER, snapshot, WALLET } from "./fixtures";
import { buildPortfolio } from "./model";

const build = (
  s: ReturnType<typeof snapshot>,
  quotes: Record<string, { yesBid: number | null; yesAsk: number | null } | null> = {},
) =>
  buildPortfolio({
    wallet: WALLET,
    markets: [NVDA, AAPL, MSFT],
    snapshot: s,
    quotes,
    usdcBalance: 1_250_000_000n,
  });

const CENT = 10_000n;

describe("buildPortfolio", () => {
  it("an open position gets avg entry, a midpoint mark, unrealized and the if-right-pays figure", () => {
    const model = build(
      snapshot({
        holdings: { [NVDA.address]: { yes: 10n, no: 0n } },
        events: [
          fill("a", NVDA.address, {
            taker: WALLET,
            maker: OTHER,
            takerSide: "Bid",
            price: 40,
            qty: 10n,
          }),
        ],
      }),
      { [NVDA.address]: { yesBid: 58, yesAsk: 61 } },
    );
    const [row] = model.rows;
    expect(row).toMatchObject({
      side: "YES",
      qty: 10n,
      cost: 10n * 40n * CENT,
      mark: 595n,
      ifRightPays: 10_000_000n,
      state: "open",
      realized: 0n,
      // 59.5¢ × 10 − 40¢ × 10 = $1.95
      unrealized: 1_950_000n,
    });
    expect(model.totals.unrealized).toBe(1_950_000n);
    expect(model.incompleteHistory).toBe(false);
  });

  it("a NO position is marked at 100¢ less the YES mid", () => {
    const model = build(
      snapshot({
        holdings: { [NVDA.address]: { yes: 0n, no: 10n } },
        events: [
          {
            kind: "PairsMinted",
            signature: "m",
            blockTime: 1,
            market: NVDA.address,
            user: WALLET,
            qty: 10n,
            pairsOutstanding: 10n,
          },
          fill("m", NVDA.address, {
            taker: WALLET,
            maker: OTHER,
            takerSide: "Ask",
            price: 58,
            qty: 10n,
          }),
        ],
      }),
      { [NVDA.address]: { yesBid: 56, yesAsk: 56 } },
    );
    const [row] = model.rows;
    expect(row).toMatchObject({ side: "NO", cost: 10n * 42n * CENT, mark: 440n });
    // 44¢ × 10 − 42¢ × 10 = $0.20
    expect(row?.unrealized).toBe(200_000n);
  });

  it("YES resting in asks and free YES in OpenOrders count toward the quantity held", () => {
    const model = build(
      snapshot({
        holdings: { [NVDA.address]: { yes: 2n, no: 0n } },
        openOrders: [{ market: NVDA.address, freeUsdc: 0n, freeYes: 3n, restingCount: 1 }],
        resting: [{ market: NVDA.address, orderId: 1n, side: "Ask", price: 60, qty: 5n }],
        events: [
          fill("a", NVDA.address, {
            taker: WALLET,
            maker: OTHER,
            takerSide: "Bid",
            price: 40,
            qty: 10n,
          }),
        ],
      }),
    );
    expect(model.rows[0]?.qty).toBe(10n);
    expect(model.incompleteHistory).toBe(false);
  });

  it("a settled winner shows payout and redeemable wallet tokens; a loser pays $0.00", () => {
    const model = build(
      snapshot({
        holdings: { [AAPL.address]: { yes: 40n, no: 0n }, [MSFT.address]: { yes: 5n, no: 0n } },
        events: [
          fill("a", AAPL.address, {
            taker: WALLET,
            maker: OTHER,
            takerSide: "Bid",
            price: 55,
            qty: 40n,
          }),
          fill("b", MSFT.address, {
            taker: WALLET,
            maker: OTHER,
            takerSide: "Bid",
            price: 30,
            qty: 5n,
          }),
        ],
      }),
    );
    const won = model.rows.find((r) => r.market === AAPL);
    const lost = model.rows.find((r) => r.market === MSFT);
    expect(won).toMatchObject({ state: "won", ifRightPays: 40_000_000n, mark: 1000n });
    expect(lost).toMatchObject({ state: "lost", ifRightPays: 0n, mark: 0n });
    expect(model.redeemable).toEqual([
      { market: AAPL, yesQty: 40n, noQty: 0n, payout: 40_000_000n },
    ]);
    expect(model.totals.redeemable).toBe(40_000_000n);
    // Winner: (100 − 55)¢ × 40 = $18.00; loser: (0 − 30)¢ × 5 = −$1.50.
    expect(won?.unrealized).toBe(18_000_000n - 0n);
    expect(lost?.unrealized).toBe(-1_500_000n);
  });

  it("a fully exited position keeps its realized P&L and is 'exited'", () => {
    const model = build(
      snapshot({
        events: [
          fill("a", NVDA.address, {
            taker: WALLET,
            maker: OTHER,
            takerSide: "Bid",
            price: 40,
            qty: 10n,
          }),
          fill("b", NVDA.address, {
            taker: WALLET,
            maker: OTHER,
            takerSide: "Ask",
            price: 36,
            qty: 10n,
          }),
        ],
      }),
    );
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ state: "exited", qty: 0n, realized: -40n * CENT });
    expect(model.totals.realized).toBe(-40n * CENT);
  });

  it("holdings the events cannot explain are flagged and show no P&L", () => {
    const model = build(snapshot({ holdings: { [NVDA.address]: { yes: 7n, no: 0n } } }));
    expect(model.rows[0]).toMatchObject({ qty: 7n, cost: null, unrealized: null, realized: null });
    expect(model.incompleteHistory).toBe(true);
    expect(build(snapshot({ eventsPartial: true })).incompleteHistory).toBe(true);
  });

  it("the MM block lists strikes with open orders or unsettled balances; empty otherwise", () => {
    const empty = build(snapshot());
    expect(empty.mm).toMatchObject({ strikes: [], openOrders: 0, withdrawable: [] });
    const model = build(
      snapshot({
        holdings: { [NVDA.address]: { yes: 25n, no: 0n } },
        openOrders: [{ market: NVDA.address, freeUsdc: 12_400_000n, freeYes: 0n, restingCount: 3 }],
        resting: [{ market: NVDA.address, orderId: 1n, side: "Bid", price: 40, qty: 5n }],
        events: [
          fill("a", NVDA.address, {
            taker: WALLET,
            maker: OTHER,
            takerSide: "Bid",
            price: 40,
            qty: 25n,
          }),
        ],
      }),
    );
    expect(model.mm.strikes).toEqual([{ market: NVDA, net: 25n, resting: 3 }]);
    expect(model.mm).toMatchObject({ openOrders: 3, unsettledUsdc: 12_400_000n });
    expect(model.mm.withdrawable).toEqual([NVDA]);
    expect(model.resting[0]).toMatchObject({ orderId: 1n, marketRow: NVDA });
  });
});
