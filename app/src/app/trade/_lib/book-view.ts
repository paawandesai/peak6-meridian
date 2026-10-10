/**
 * The full order book as the Trade page shows it (design.md §5 Trade): price levels, the YES and
 * NO views, spread and midpoint, and the maker accounts a taking order must name. Pure and
 * integer-only; prices are whole cents 1–99.
 */
import {
  complementCents,
  type Intent,
  noViewOfBook,
  yesMidCents,
  type PricedOrder,
} from "@meridian/client";

/** One resting order. `seq` is the arrival sequence (price-time priority). */
export type BookOrder = {
  readonly orderId: bigint;
  readonly owner: string;
  readonly price: number;
  readonly qty: bigint;
  readonly seq: bigint;
};

export type FullBook = { readonly bids: readonly BookOrder[]; readonly asks: readonly BookOrder[] };

export type Level = PricedOrder & { readonly qty: bigint };

export type BookLevels = { readonly bids: readonly Level[]; readonly asks: readonly Level[] };

/** Aggregates orders into price levels: bids highest first, asks lowest first. */
export function levelsOf(book: FullBook): BookLevels {
  const fold = (
    orders: readonly BookOrder[],
    better: (a: number, b: number) => number,
  ): Level[] => {
    const byPrice = new Map<number, bigint>();
    for (const order of orders) {
      if (order.qty > 0n) byPrice.set(order.price, (byPrice.get(order.price) ?? 0n) + order.qty);
    }
    return [...byPrice.entries()]
      .sort(([a], [b]) => better(a, b))
      .map(([price, qty]) => ({ price, qty }));
  };
  return { bids: fold(book.bids, (a, b) => b - a), asks: fold(book.asks, (a, b) => a - b) };
}

/** The NO view: YES asks become NO bids at 100 − p, YES bids become NO asks at 100 − p. */
export function noView(levels: BookLevels): BookLevels {
  return noViewOfBook<Level>(levels);
}

export type Spread = {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  /** `ask − bid`, or `null` when a side is empty or the book is crossed. */
  readonly spread: number | null;
  /** Integer-floor midpoint, or `null` under the same conditions. */
  readonly mid: number | null;
};

export function spreadOf(levels: BookLevels): Spread {
  const bestBid = levels.bids[0]?.price ?? null;
  const bestAsk = levels.asks[0]?.price ?? null;
  if (bestBid === null || bestAsk === null || bestBid > bestAsk) {
    return { bestBid, bestAsk, spread: null, mid: null };
  }
  return { bestBid, bestAsk, spread: bestAsk - bestBid, mid: yesMidCents(bestBid, bestAsk) };
}

/**
 * The derived-NO line, a template with the live numbers (design.md §3 "YES vs NO"):
 * `NO 42¢ = 100 − 58¢ YES; YES + NO = 100¢`. Without a price it states the rule only.
 */
export function derivedNoLine(yesCents: number | null): string {
  if (yesCents === null) return "NO = 100 − YES; YES + NO = 100¢";
  return `NO ${complementCents(yesCents)}¢ = 100 − ${yesCents}¢ YES; YES + NO = 100¢`;
}

/** Maximum fills one instruction can make (domain.md § Order book rules). */
export const MAX_FILLS = 8;

/**
 * Owners whose `OpenOrders` a taking order may credit: the resting orders it can cross, in
 * price-time priority, first {@link MAX_FILLS} orders, one entry per owner, never the taker (its
 * own account is already part of the instruction). `yesPrice` is the limit or worst price in YES
 * terms.
 */
export function makersFor(
  intent: Intent,
  yesPrice: number,
  book: FullBook,
  user: string,
): string[] {
  // A buy of YES (Buy YES, Sell NO) takes asks at or below the price; a sale of YES takes bids at
  // or above it.
  const takesAsks = intent === "BUY_YES" || intent === "SELL_NO";
  const crossing = takesAsks
    ? book.asks
        .filter((order) => order.qty > 0n && order.price <= yesPrice)
        .sort((a, b) => a.price - b.price || cmp(a.seq, b.seq))
    : book.bids
        .filter((order) => order.qty > 0n && order.price >= yesPrice)
        .sort((a, b) => b.price - a.price || cmp(a.seq, b.seq));
  const owners: string[] = [];
  for (const order of crossing.slice(0, MAX_FILLS)) {
    if (order.owner !== user && !owners.includes(order.owner)) owners.push(order.owner);
  }
  return owners;
}

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The wallet's own resting orders, both sides, for the Cancel list. */
export function ownOrders(
  book: FullBook,
  user: string,
): readonly (BookOrder & { readonly side: "Bid" | "Ask" })[] {
  return [
    ...book.bids
      .filter((o) => o.owner === user && o.qty > 0n)
      .map((o) => ({ ...o, side: "Bid" as const })),
    ...book.asks
      .filter((o) => o.owner === user && o.qty > 0n)
      .map((o) => ({ ...o, side: "Ask" as const })),
  ];
}

/**
 * A price level named in YES terms, `ask:61` or `bid:58`. The highlight after a fill is kept in
 * YES terms so the YES and NO views mark the same level of the one book.
 */
export type LevelKey = `${"ask" | "bid"}:${number}`;

export const levelKey = (side: "ask" | "bid", price: number): LevelKey => `${side}:${price}`;

/**
 * The YES-terms levels whose quantity differs between two reads (added, removed or resized),
 * asks first then bids, each in ascending price. Equal books give an empty list.
 */
export function changedLevels(previous: BookLevels, next: BookLevels): LevelKey[] {
  const diff = (side: "ask" | "bid", a: readonly Level[], b: readonly Level[]): LevelKey[] => {
    const before = new Map(a.map((level) => [level.price, level.qty]));
    const after = new Map(b.map((level) => [level.price, level.qty]));
    const prices = [...new Set([...before.keys(), ...after.keys()])].sort((x, y) => x - y);
    return prices
      .filter((price) => (before.get(price) ?? 0n) !== (after.get(price) ?? 0n))
      .map((price) => levelKey(side, price));
  };
  return [...diff("ask", previous.asks, next.asks), ...diff("bid", previous.bids, next.bids)];
}

/**
 * The YES level a NO-view row relabels: the NO view lists YES asks as NO bids at 100 − p and YES
 * bids as NO asks at 100 − p, so a NO row maps back to the opposite YES side at 100 − its price.
 */
export function yesKeyOfNoRow(side: "ask" | "bid", noPrice: number): LevelKey {
  return levelKey(side === "bid" ? "ask" : "bid", complementCents(noPrice));
}

/** Width of a depth bar: the level's share of the largest level shown, whole percent 0–100. */
export function depthPercent(qty: bigint, maxQty: bigint): number {
  if (maxQty <= 0n || qty <= 0n) return 0;
  const capped = qty > maxQty ? maxQty : qty;
  return Number((capped * 100n) / maxQty);
}

/** The displayed-price rule (design.md §3): the YES mid only when the spread is at most 10¢. */
export const MAX_DISPLAY_SPREAD_CENTS = 10;

/** The YES price the Trade header shows, or `null` for a one-sided, crossed or wide book. */
export function displayedYesOfLevels(levels: BookLevels): number | null {
  const { spread, mid } = spreadOf(levels);
  return spread !== null && spread <= MAX_DISPLAY_SPREAD_CENTS ? mid : null;
}
