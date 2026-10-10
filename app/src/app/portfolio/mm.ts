/**
 * Market-maker block (P1-5, design.md §2 Portfolio item 3): per-strike net exposure, the wallet's
 * resting orders as the book holds them, escrow and the unsettled OpenOrders balance. Pure and
 * exact: every figure is a `bigint` of contracts or USDC base units taken from the snapshot the
 * Portfolio already reads (OpenOrders accounts + one batched `getMultipleAccounts` of the books),
 * so it adds no RPC call of its own.
 */
import { BASE_UNITS_PER_CENT } from "@meridian/client";

import type { OpenOrdersRow, RestingOrder } from "./data";
import type { MarketRow } from "@/lib/markets";

/** One side of the wallet's resting orders in a market. */
export type MmSide = {
  /** Number of resting orders on this side. */
  readonly count: number;
  /** Contracts resting on this side. */
  readonly qty: bigint;
  /** Best own price in cents (highest bid, lowest ask); `null` with no orders. */
  readonly best: number | null;
};

export type MmStrike = {
  readonly market: MarketRow;
  /** YES-equivalent exposure held now: YES (wallet, free, resting in asks) less NO held. */
  readonly net: bigint;
  /** Resting orders according to the wallet's OpenOrders account (`resting_count`). */
  readonly resting: number;
  readonly bids: MmSide;
  readonly asks: MmSide;
  /** Net exposure if every resting bid fills (buys YES). */
  readonly netIfBidsFill: bigint;
  /** Net exposure if every resting ask fills (sells YES). */
  readonly netIfAsksFill: bigint;
  /** USDC escrowed by resting bids: Σ price × 10,000 × qty (domain.md § Order book). */
  readonly escrowUsdc: bigint;
  /** YES escrowed by resting asks. */
  readonly escrowYes: bigint;
  /** Free OpenOrders balance owed to the wallet (withdrawn with `settle_funds`). */
  readonly freeUsdc: bigint;
  readonly freeYes: bigint;
  /** True when the book's order count differs from `resting_count` (a book read is missing). */
  readonly mismatch: boolean;
};

export type MmBlockModel = {
  /** Strikes with a resting order or an unsettled balance, ticker / newest date / strike order. */
  readonly strikes: readonly MmStrike[];
  /** Σ `resting_count` over the wallet's OpenOrders accounts. */
  readonly openOrders: number;
  readonly bidQty: bigint;
  readonly askQty: bigint;
  readonly escrowUsdc: bigint;
  readonly unsettledUsdc: bigint;
  readonly unsettledYes: bigint;
  /** Markets with something to withdraw. */
  readonly withdrawable: readonly MarketRow[];
};

export type MmInput = {
  readonly markets: readonly MarketRow[];
  readonly openOrders: readonly OpenOrdersRow[];
  readonly resting: readonly RestingOrder[];
  /** Net YES-equivalent held per market address (absent = 0). */
  readonly netByMarket: ReadonlyMap<string, bigint>;
};

const EMPTY_SIDE: MmSide = { count: 0, qty: 0n, best: null };

/** Folds one order into a side; `better` says whether a price beats the current best. */
function addOrder(side: MmSide, order: RestingOrder, better: (a: number, b: number) => boolean) {
  return {
    count: side.count + 1,
    qty: side.qty + order.qty,
    best: side.best === null || better(order.price, side.best) ? order.price : side.best,
  };
}

/** Escrow of resting bids in USDC base units (price cents × 10,000 × qty), exact. */
export function bidEscrow(orders: readonly RestingOrder[]): bigint {
  let total = 0n;
  for (const order of orders) {
    if (order.side === "Bid") total += BigInt(order.price) * BASE_UNITS_PER_CENT * order.qty;
  }
  return total;
}

/** Bid and ask aggregates of one market's resting orders. */
export function sides(orders: readonly RestingOrder[]): { bids: MmSide; asks: MmSide } {
  let bids = EMPTY_SIDE;
  let asks = EMPTY_SIDE;
  for (const order of orders) {
    if (order.side === "Bid") bids = addOrder(bids, order, (a, b) => a > b);
    else asks = addOrder(asks, order, (a, b) => a < b);
  }
  return { bids, asks };
}

function compareMarkets(a: MarketRow, b: MarketRow): number {
  return (
    a.ticker.localeCompare(b.ticker) ||
    b.tradingDate - a.tradingDate ||
    (a.strikeCents < b.strikeCents ? -1 : a.strikeCents > b.strikeCents ? 1 : 0)
  );
}

export function buildMmBlock(input: MmInput): MmBlockModel {
  const byMarket = new Map(input.markets.map((market) => [market.address, market]));
  const ordersByMarket = new Map<string, RestingOrder[]>();
  for (const order of input.resting) {
    const list = ordersByMarket.get(order.market) ?? [];
    list.push(order);
    ordersByMarket.set(order.market, list);
  }

  const strikes: MmStrike[] = [];
  for (const row of input.openOrders) {
    const market = byMarket.get(row.market);
    const orders = ordersByMarket.get(row.market) ?? [];
    const active =
      row.restingCount > 0 || orders.length > 0 || row.freeUsdc > 0n || row.freeYes > 0n;
    if (market === undefined || !active) continue;
    const { bids, asks } = sides(orders);
    const net = input.netByMarket.get(row.market) ?? 0n;
    strikes.push({
      market,
      net,
      resting: row.restingCount,
      bids,
      asks,
      netIfBidsFill: net + bids.qty,
      netIfAsksFill: net - asks.qty,
      escrowUsdc: bidEscrow(orders),
      escrowYes: asks.qty,
      freeUsdc: row.freeUsdc,
      freeYes: row.freeYes,
      mismatch: bids.count + asks.count !== row.restingCount,
    });
  }
  strikes.sort((a, b) => compareMarkets(a.market, b.market));

  const sum = (pick: (strike: MmStrike) => bigint): bigint =>
    strikes.reduce((total, strike) => total + pick(strike), 0n);
  const unsettled = input.openOrders.filter((row) => row.freeUsdc > 0n || row.freeYes > 0n);
  return {
    strikes,
    openOrders: input.openOrders.reduce((total, row) => total + row.restingCount, 0),
    bidQty: sum((strike) => strike.bids.qty),
    askQty: sum((strike) => strike.asks.qty),
    escrowUsdc: sum((strike) => strike.escrowUsdc),
    unsettledUsdc: unsettled.reduce((total, row) => total + row.freeUsdc, 0n),
    unsettledYes: unsettled.reduce((total, row) => total + row.freeYes, 0n),
    withdrawable: unsettled.flatMap((row) => {
      const market = byMarket.get(row.market);
      return market === undefined ? [] : [market];
    }),
  };
}

/** `+25`, `−10` (U+2212), `0`: a signed contract count. */
export function formatSignedQty(value: bigint): string {
  if (value > 0n) return `+${value}`;
  if (value < 0n) return `−${-value}`;
  return "0";
}
