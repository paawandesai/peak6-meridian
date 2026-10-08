/**
 * Read-only order-book quotes (M2-05). The on-chain `Book` holds 32 bids and 32 asks of the
 * single YES-vs-USDC book (empty slots have `qty == 0`); this turns a decoded book into the
 * integer-cent quotes the UI shows. Prices are whole cents 1–99 (docs/domain.md § Units): the
 * YES mid is the integer floor of (bid + ask) / 2 and the NO price is 100 − the YES price.
 */
import type { Program } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

import type { Meridian } from "./idl/meridian";
import { findBookPda } from "./pda";
import { MERIDIAN_PROGRAM_ID } from "./program";
import { assertPriceCents, complementPriceCents, isValidPriceCents } from "./units";

/** The fields of a resting order that quotes need (`qty == 0` marks an empty slot). */
export type RestingOrderLike = {
  readonly price: number;
  readonly qty: { toString(): string };
};

/** The decoded sides of a `Book` account. */
export type BookLike = {
  readonly bids: readonly RestingOrderLike[];
  readonly asks: readonly RestingOrderLike[];
};

/** Integer-cent quotes for one market; `null` where the side (or the mid) does not exist. */
export type BookQuotes = {
  readonly yesBid: number | null;
  readonly yesAsk: number | null;
  readonly yesMid: number | null;
  readonly noPrice: number | null;
};

/** The YES mid of a bid and an ask: the integer floor of their average. */
export function yesMidCents(bid: number, ask: number): number {
  return Math.floor((assertPriceCents(bid) + assertPriceCents(ask)) / 2);
}

function pickPrice(
  orders: readonly RestingOrderLike[],
  better: (candidate: number, best: number) => boolean,
): number | null {
  let best: number | null = null;
  for (const order of orders) {
    if (BigInt(order.qty.toString()) === 0n || !isValidPriceCents(order.price)) continue;
    if (best === null || better(order.price, best)) best = order.price;
  }
  return best;
}

/**
 * Best bid (highest), best ask (lowest), mid and NO price of a book. Empty slots and slots with
 * a price outside 1–99 are ignored. The mid needs both sides and a book that is not crossed
 * (bid ≤ ask); the NO price is the complement of the mid, so it needs the same. Anything
 * missing is `null`, never a made-up number.
 */
export function bookQuotes(book: BookLike): BookQuotes {
  const yesBid = pickPrice(book.bids, (candidate, best) => candidate > best);
  const yesAsk = pickPrice(book.asks, (candidate, best) => candidate < best);
  if (yesBid === null || yesAsk === null || yesBid > yesAsk) {
    return { yesBid, yesAsk, yesMid: null, noPrice: null };
  }
  const yesMid = yesMidCents(yesBid, yesAsk);
  return { yesBid, yesAsk, yesMid, noPrice: complementPriceCents(yesMid) };
}

/** The slice of `program.account.book` that `fetchBookQuotes` uses. */
export type BookAccountApi = {
  fetchMultiple(addresses: PublicKey[]): Promise<(BookLike | null)[]>;
};

/**
 * Quotes for several markets in one RPC call, keyed by market address (base58). A market whose
 * book account is missing maps to `null`.
 */
export async function fetchBookQuotes(
  books: BookAccountApi,
  markets: readonly PublicKey[],
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): Promise<Record<string, BookQuotes | null>> {
  const addresses = markets.map((market) => findBookPda(market, programId).address);
  const accounts = await books.fetchMultiple(addresses);
  const out: Record<string, BookQuotes | null> = {};
  markets.forEach((market, index) => {
    const account = accounts[index];
    out[market.toBase58()] = account === undefined || account === null ? null : bookQuotes(account);
  });
  return out;
}

/** Convenience: the `book` account namespace of a program as a `BookAccountApi`. */
export function bookAccountApi(program: Program<Meridian>): BookAccountApi {
  return program.account.book as unknown as BookAccountApi;
}
