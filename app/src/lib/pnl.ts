/**
 * Average-cost P&L for the Portfolio (M2-07, docs/domain.md § P&L, design.md §3 "Fractional
 * cents"). Everything is exact `bigint` in USDC base units; nothing is rounded until display.
 *
 * The ledger is built from the wallet's decoded program events (`events.ts`). Cost basis is kept
 * per (market, side) as quantity plus total cost, so an average entry is `cost / qty` at display
 * time and never a stored fraction. Selling `q` of `qty` removes `floor(cost × q / qty)` of cost;
 * the floor keeps every number an integer and the books exact (cost in = cost removed + cost
 * left, always), and is at most one base unit ($0.000001) per exit away from rational lots.
 */
import { BASE_UNITS_PER_CENT, BASE_UNITS_PER_USDC, PAIR_PRICE_CENTS } from "@meridian/client";

import type { MeridianEvent } from "./events";

export type Side = "YES" | "NO";
export type MarketOutcomeName = "None" | "Yes" | "No";

/** One tenth of a cent in base units: marks are carried in tenths so a half-cent mid is exact. */
export const BASE_UNITS_PER_TENTH = BASE_UNITS_PER_CENT / 10n;
/** A mark of 100¢ in tenths of a cent. */
export const PAIR_TENTHS = BigInt(PAIR_PRICE_CENTS) * 10n;

/** A change of one side's position at a price in base units per contract. */
export type Trade = {
  readonly market: string;
  readonly side: Side;
  readonly dir: "buy" | "sell";
  readonly qty: bigint;
  /** Base units per contract. */
  readonly unit: bigint;
};

export type Position = {
  readonly qty: bigint;
  /** Total cost of the contracts still held, base units. */
  readonly cost: bigint;
  /** Realized P&L so far, base units (signed). */
  readonly realized: bigint;
  /** Contracts sold that the history never showed as bought (an incomplete history). */
  readonly shortfall: bigint;
};

export const EMPTY_POSITION: Position = { qty: 0n, cost: 0n, realized: 0n, shortfall: 0n };

const cents = (value: number): bigint => BigInt(value) * BASE_UNITS_PER_CENT;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Applies one trade to a position (average-cost accounting). */
export function applyTrade(position: Position, trade: Trade): Position {
  if (trade.qty <= 0n) return position;
  if (trade.dir === "buy") {
    return {
      ...position,
      qty: position.qty + trade.qty,
      cost: position.cost + trade.qty * trade.unit,
    };
  }
  const sold = min(trade.qty, position.qty);
  const removed = position.qty === 0n ? 0n : (position.cost * sold) / position.qty;
  return {
    qty: position.qty - sold,
    cost: position.cost - removed,
    realized: position.realized + sold * trade.unit - removed,
    shortfall: position.shortfall + (trade.qty - sold),
  };
}

export const positionKey = (market: string, side: Side): string => `${market}:${side}`;

/** Folds trades, oldest first, into one position per (market, side). */
export function ledger(trades: readonly Trade[]): Map<string, Position> {
  const positions = new Map<string, Position>();
  for (const trade of trades) {
    const key = positionKey(trade.market, trade.side);
    positions.set(key, applyTrade(positions.get(key) ?? EMPTY_POSITION, trade));
  }
  return positions;
}

type FillEvent = Extract<MeridianEvent, { kind: "Fill" }>;
type Chunk = { price: number; qty: bigint };

/** Takes up to `qty` from the front of `queue`, returning the chunks taken. */
function takeFrom(queue: Chunk[], qty: bigint): Chunk[] {
  const taken: Chunk[] = [];
  let remaining = qty;
  while (remaining > 0n && queue.length > 0) {
    const head = queue[0];
    if (head === undefined) break;
    const part = min(remaining, head.qty);
    taken.push({ price: head.price, qty: part });
    remaining -= part;
    if (part === head.qty) queue.shift();
    else head.qty -= part;
  }
  return taken;
}

export type TradeExtraction = {
  readonly trades: readonly Trade[];
  /** The last YES price (cents) the wallet traded at per market: the fallback mark. */
  readonly lastYesCents: Readonly<Record<string, number>>;
  /** Events that touched the wallet but could not be placed in the ledger. */
  readonly skipped: number;
};

/**
 * Turns the wallet's events into ledger trades. Events are grouped by transaction so the compound
 * paths come out right (domain.md § P&L): the pair mint of a Buy NO plus the YES it sells at
 * price p is a purchase of NO at 100 − p, and a Sell NO (YES bought at p, pair redeemed) is a
 * sale of NO at 100 − p. A pair minted or redeemed on its own is booked at 50¢ a side (the cost
 * of a pair is 100¢; the split is a convention and the two sides always add to the true cost).
 * After settlement, a one-sided redeem pays the winning side 100¢ and the losing side 0¢.
 *
 * `events` must be oldest first. `outcomes` is the settled outcome per market address.
 */
export function tradesFromEvents(
  events: readonly MeridianEvent[],
  wallet: string,
  outcomes: Readonly<Record<string, MarketOutcomeName>> = {},
): TradeExtraction {
  const groups: MeridianEvent[][] = [];
  const index = new Map<string, MeridianEvent[]>();
  for (const event of events) {
    let group = index.get(event.signature);
    if (group === undefined) {
      group = [];
      index.set(event.signature, group);
      groups.push(group);
    }
    group.push(event);
  }

  const trades: Trade[] = [];
  const lastYesCents: Record<string, number> = {};
  let skipped = 0;

  for (const group of groups) {
    const buys: Trade[] = [];
    const sells: Trade[] = [];
    const add = (market: string, side: Side, dir: "buy" | "sell", qty: bigint, unit: bigint) =>
      (dir === "buy" ? buys : sells).push({ market, side, dir, qty, unit });
    const queues = new Map<string, { ask: Chunk[]; bid: Chunk[] }>();
    const queue = (market: string) => {
      let q = queues.get(market);
      if (q === undefined) {
        q = { ask: [], bid: [] };
        queues.set(market, q);
      }
      return q;
    };

    for (const event of group) {
      if (event.kind !== "Fill") continue;
      const fill: FillEvent = event;
      if (fill.taker === wallet) {
        queue(fill.market)[fill.takerSide === "Ask" ? "ask" : "bid"].push({
          price: fill.price,
          qty: fill.qty,
        });
        lastYesCents[fill.market] = fill.price;
      } else if (fill.maker === wallet) {
        add(
          fill.market,
          "YES",
          fill.takerSide === "Ask" ? "buy" : "sell",
          fill.qty,
          cents(fill.price),
        );
        lastYesCents[fill.market] = fill.price;
      }
    }

    for (const event of group) {
      if (event.kind === "PairsMinted" && event.user === wallet) {
        const q = queue(event.market);
        let rest = event.qty;
        for (const chunk of takeFrom(q.ask, event.qty)) {
          // Buy NO: the YES sold at p nets out, leaving NO bought at 100 − p.
          add(event.market, "NO", "buy", chunk.qty, cents(PAIR_PRICE_CENTS - chunk.price));
          rest -= chunk.qty;
        }
        if (rest > 0n) {
          add(event.market, "YES", "buy", rest, cents(PAIR_PRICE_CENTS / 2));
          add(event.market, "NO", "buy", rest, cents(PAIR_PRICE_CENTS / 2));
        }
      } else if (event.kind === "Redeemed" && event.user === wallet) {
        const q = queue(event.market);
        const outcome = outcomes[event.market] ?? "None";

        // Post-settlement: book at 100c/0c per outcome, even when yesQty === noQty
        if (outcome !== "None") {
          const yesUnit = outcome === "Yes" ? BASE_UNITS_PER_USDC : 0n;
          add(event.market, "YES", "sell", event.yesQty, yesUnit);
          add(event.market, "NO", "sell", event.noQty, BASE_UNITS_PER_USDC - yesUnit);
        } else if (event.yesQty === event.noQty) {
          // Pre-settlement pair redeem: book at average cost (50c fallback)
          let rest = event.yesQty;
          for (const chunk of takeFrom(q.bid, event.yesQty)) {
            // Sell NO: the YES bought at p nets out, leaving NO sold at 100 − p.
            add(event.market, "NO", "sell", chunk.qty, cents(PAIR_PRICE_CENTS - chunk.price));
            rest -= chunk.qty;
          }
          if (rest > 0n) {
            add(event.market, "YES", "sell", rest, cents(PAIR_PRICE_CENTS / 2));
            add(event.market, "NO", "sell", rest, cents(PAIR_PRICE_CENTS / 2));
          }
        } else {
          // Unequal-qty redeem before settlement: skip (need outcome)
          skipped += 1;
          continue;
        }
      }
    }

    for (const [market, q] of queues) {
      for (const chunk of q.ask) add(market, "YES", "sell", chunk.qty, cents(chunk.price));
      for (const chunk of q.bid) add(market, "YES", "buy", chunk.qty, cents(chunk.price));
    }
    trades.push(...buys, ...sells);
  }
  return { trades, lastYesCents, skipped };
}

/** The YES book quotes this module needs (whole cents; `null` for a missing side). */
export type YesQuotes = { readonly yesBid: number | null; readonly yesAsk: number | null };

/**
 * The YES mark in tenths of a cent: the book midpoint `(bid + ask) × 5` when both sides exist
 * (exact: 58¢/61¢ → 595 tenths = 59.5¢); otherwise the last price the wallet traded at; else
 * `null` (no honest mark). A settled market is marked 100¢ or 0¢. Fair value (domain.md's last
 * fallback) is a backend figure the browser does not have, so it is not used.
 */
export function yesMarkTenths(input: {
  readonly outcome: MarketOutcomeName;
  readonly quotes: YesQuotes | null;
  readonly lastYesCents: number | undefined;
}): bigint | null {
  if (input.outcome === "Yes") return PAIR_TENTHS;
  if (input.outcome === "No") return 0n;
  const quotes = input.quotes;
  if (quotes !== null && quotes.yesBid !== null && quotes.yesAsk !== null) {
    return (BigInt(quotes.yesBid) + BigInt(quotes.yesAsk)) * 5n;
  }
  return input.lastYesCents === undefined ? null : BigInt(input.lastYesCents) * 10n;
}

/** NO is the complement of YES: 100¢ less the YES mark. */
export function markTenths(side: Side, yesTenths: bigint | null): bigint | null {
  if (yesTenths === null) return null;
  return side === "YES" ? yesTenths : PAIR_TENTHS - yesTenths;
}

/** A mark in tenths of a cent as base units per contract. */
export const tenthsToBase = (tenths: bigint): bigint => tenths * BASE_UNITS_PER_TENTH;

/** Unrealized P&L: `mark_base × qty − total_cost`. */
export function unrealized(mark: bigint | null, qty: bigint, cost: bigint): bigint | null {
  return mark === null ? null : tenthsToBase(mark) * qty - cost;
}

/** What `qty` contracts of the winning side pay: $1.00 each. */
export const ifRightPays = (qty: bigint): bigint => qty * BASE_UNITS_PER_USDC;
