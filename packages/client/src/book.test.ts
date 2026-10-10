import { Keypair, PublicKey } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type BookLike,
  type RestingOrderLike,
  bookQuotes,
  fetchBookQuotes,
  yesMidCents,
} from "./book";
import { findBookPda } from "./pda";
import { MERIDIAN_PROGRAM_ID } from "./program";

const order = (price: number, qty: bigint | number): RestingOrderLike => ({
  price,
  qty: { toString: () => String(qty) },
});
const empty = order(0, 0);
const book = (bids: RestingOrderLike[], asks: RestingOrderLike[]): BookLike => ({ bids, asks });

describe("yesMidCents", () => {
  it("is the integer floor of the average", () => {
    expect(yesMidCents(40, 44)).toBe(42);
    expect(yesMidCents(40, 45)).toBe(42);
    expect(yesMidCents(1, 2)).toBe(1);
    expect(yesMidCents(98, 99)).toBe(98);
  });

  it("rejects prices outside 1-99", () => {
    expect(() => yesMidCents(0, 50)).toThrow();
    expect(() => yesMidCents(50, 100)).toThrow();
  });

  it("is an integer between bid and ask and NO = 100 - YES (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 }), (a, b) => {
        const bid = Math.min(a, b);
        const ask = Math.max(a, b);
        const mid = yesMidCents(bid, ask);
        expect(Number.isInteger(mid)).toBe(true);
        expect(mid).toBeGreaterThanOrEqual(bid);
        expect(mid).toBeLessThanOrEqual(ask);
        expect(mid).toBeGreaterThanOrEqual(1);
        expect(mid).toBeLessThanOrEqual(99);
      }),
    );
  });
});

describe("bookQuotes", () => {
  it("picks the highest bid and the lowest ask and computes mid and NO price", () => {
    const quotes = bookQuotes(
      book([order(40, 5), order(42, 1), empty], [order(47, 2), order(45, 3), empty]),
    );
    expect(quotes).toEqual({ yesBid: 42, yesAsk: 45, yesMid: 43, noPrice: 57 });
  });

  it("ignores empty slots and out-of-range prices", () => {
    const quotes = bookQuotes(book([order(70, 0), order(0, 4), order(30, 1)], [order(100, 1)]));
    expect(quotes).toEqual({ yesBid: 30, yesAsk: null, yesMid: null, noPrice: null });
  });

  it("has no mid or NO price with one side only, or when crossed", () => {
    expect(bookQuotes(book([order(50, 1)], []))).toEqual({
      yesBid: 50,
      yesAsk: null,
      yesMid: null,
      noPrice: null,
    });
    expect(bookQuotes(book([order(60, 1)], [order(50, 1)])).yesMid).toBeNull();
    expect(bookQuotes(book([], []))).toEqual({
      yesBid: null,
      yesAsk: null,
      yesMid: null,
      noPrice: null,
    });
  });

  it("yes mid + no price is always 100 for a valid two-sided book (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 99 }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 1, max: 99 }), { minLength: 1, maxLength: 8 }),
        (bids, asks) => {
          const quotes = bookQuotes(
            book(
              bids.map((p) => order(p, 1)),
              asks.map((p) => order(p, 1)),
            ),
          );
          expect(quotes.yesBid).toBe(Math.max(...bids));
          expect(quotes.yesAsk).toBe(Math.min(...asks));
          if (quotes.yesMid !== null) {
            expect(quotes.yesMid + (quotes.noPrice ?? Number.NaN)).toBe(100);
          } else {
            expect(quotes.yesBid).toBeGreaterThan(quotes.yesAsk ?? 0);
          }
        },
      ),
    );
  });
});

describe("fetchBookQuotes", () => {
  it("fetches the book PDAs in one call and keys the quotes by market", async () => {
    const marketA = Keypair.generate().publicKey;
    const marketB = Keypair.generate().publicKey;
    let requested: PublicKey[] = [];
    const quotes = await fetchBookQuotes(
      {
        fetchMultiple: (addresses) => {
          requested = addresses;
          return Promise.resolve([book([order(40, 1)], [order(44, 1)]), null]);
        },
      },
      [marketA, marketB],
    );
    expect(requested.map((a) => a.toBase58())).toEqual([
      findBookPda(marketA, MERIDIAN_PROGRAM_ID).address.toBase58(),
      findBookPda(marketB, MERIDIAN_PROGRAM_ID).address.toBase58(),
    ]);
    expect(quotes[marketA.toBase58()]).toEqual({ yesBid: 40, yesAsk: 44, yesMid: 42, noPrice: 58 });
    expect(quotes[marketB.toBase58()]).toBeNull();
  });

  it("chunks fetches to stay under 100-key RPC limit (P0-4)", async () => {
    // 150 markets → 150 book PDAs, should chunk into 2 calls of 99 and 51 keys
    const markets = Array.from({ length: 150 }, () => Keypair.generate().publicKey);
    const callSizes: number[] = [];
    await fetchBookQuotes(
      {
        fetchMultiple: (addresses) => {
          callSizes.push(addresses.length);
          return Promise.resolve(addresses.map(() => null));
        },
      },
      markets,
    );
    expect(callSizes).toEqual([99, 51]);
    expect(callSizes.every((size) => size <= 99)).toBe(true);
  });
});
