/**
 * The four trade intents of the one YES-vs-USDC book (docs/domain.md § The four trade paths)
 * and the single instruction each one builds. This mapping is the AB-18 surface: a wrong side
 * or price transform here would sell the user the opposite position, so every rule lives in one
 * small, pure place that `tests/security/ts/ab_18_intents.test.ts` pins down.
 *
 * Prices are whole cents. For the NO intents `priceCents` is the NO price the user sees; the
 * program takes the YES price (NO price = 100 − YES price).
 */
import { type Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

import { BN } from "./bn";
import type { Meridian } from "./idl/meridian";
import { findConfigPda, findOpenOrdersPda, type MarketAddresses } from "./pda";
import { MAX_PRICE_CENTS, MIN_PRICE_CENTS, PAIR_PRICE_CENTS } from "./units";

/** SPL Token program. */
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export type Intent = "BUY_YES" | "SELL_YES" | "BUY_NO" | "SELL_NO";
/** `limit` rests the remainder; `ioc` cancels it (a "market" order is an IOC at a worst price). */
export type OrderKindName = "limit" | "ioc";
export type BookSide = "bid" | "ask";

/** The program instruction each intent maps to, and the book side it trades on. */
export const INTENT_INSTRUCTION = {
  BUY_YES: { instruction: "place_order", side: "bid" },
  SELL_YES: { instruction: "place_order", side: "ask" },
  BUY_NO: { instruction: "buy_no", side: "ask" },
  SELL_NO: { instruction: "sell_no", side: "bid" },
} as const satisfies Record<Intent, { instruction: string; side: BookSide }>;

export class IntentError extends Error {
  override readonly name = "IntentError";
}

function requirePrice(priceCents: number): void {
  if (
    !Number.isInteger(priceCents) ||
    priceCents < MIN_PRICE_CENTS ||
    priceCents > MAX_PRICE_CENTS
  ) {
    throw new IntentError(
      `price must be a whole number of cents from ${MIN_PRICE_CENTS} to ${MAX_PRICE_CENTS}: ${priceCents}`,
    );
  }
}

/** The price of the other side of a pair: p ↔ 100 − p. Its own inverse. */
export function complementCents(priceCents: number): number {
  requirePrice(priceCents);
  return PAIR_PRICE_CENTS - priceCents;
}

/** The YES price the program receives for an intent priced at `priceCents` in its own terms. */
export function yesPriceFor(intent: Intent, priceCents: number): number {
  requirePrice(priceCents);
  return intent === "BUY_NO" || intent === "SELL_NO" ? complementCents(priceCents) : priceCents;
}

/** Everything `buildTrade` needs to name accounts. */
export type TradeAccounts = {
  readonly user: PublicKey;
  readonly userUsdc: PublicKey;
  readonly userYes: PublicKey;
  /** Only the NO intents touch it; defaults to a missing-account error for them. */
  readonly userNo?: PublicKey;
  readonly market: MarketAddresses;
};

export type TradeParams = {
  readonly program: Program<Meridian>;
  readonly intent: Intent;
  readonly kind: OrderKindName;
  /** Limit or worst price in cents, 1–99, in the terms of the intent (NO price for NO intents). */
  readonly priceCents: number;
  /** Whole contracts, at least 1. */
  readonly qty: bigint;
  readonly accounts: TradeAccounts;
  /** Owners of the resting orders this one may match; their OpenOrders are credited. */
  readonly makers?: readonly PublicKey[];
};

function orderKindArg(
  kind: OrderKindName,
): { limit: Record<string, never> } | { ioc: Record<string, never> } {
  return kind === "limit" ? { limit: {} } : { ioc: {} };
}

/**
 * The single instruction that carries out `intent`:
 * - BUY_YES → `place_order` bid at the price; SELL_YES → `place_order` ask at the price;
 * - BUY_NO → `buy_no` with YES floor 100 − NO price;
 * - SELL_NO → `sell_no` (always IOC) with YES cap 100 − NO price.
 */
export async function buildTrade(params: TradeParams): Promise<TransactionInstruction> {
  const { program, intent, kind, priceCents, accounts } = params;
  if (params.qty < 1n) {
    throw new IntentError(`quantity must be at least 1 contract: ${params.qty}`);
  }
  if (intent === "SELL_NO" && kind !== "ioc") {
    throw new IntentError("SELL_NO is immediate-or-cancel only");
  }
  const price = yesPriceFor(intent, priceCents);
  const qty = new BN(params.qty.toString());
  const marketKey = accounts.market.market;
  const remaining = (params.makers ?? []).map((owner) => ({
    pubkey: findOpenOrdersPda(marketKey, owner, program.programId).address,
    isSigner: false,
    isWritable: true,
  }));
  const common = {
    config: findConfigPda(program.programId).address,
    market: marketKey,
    book: accounts.market.book,
    user: accounts.user,
    openOrders: findOpenOrdersPda(marketKey, accounts.user, program.programId).address,
    userUsdc: accounts.userUsdc,
    userYes: accounts.userYes,
    escrowUsdc: accounts.market.escrowUsdc,
    escrowYes: accounts.market.escrowYes,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };

  switch (intent) {
    case "BUY_YES":
    case "SELL_YES":
      return program.methods
        .placeOrder(
          INTENT_INSTRUCTION[intent].side === "bid" ? { bid: {} } : { ask: {} },
          price,
          qty,
          orderKindArg(kind),
        )
        .accountsStrict(common)
        .remainingAccounts(remaining)
        .instruction();
    case "BUY_NO":
    case "SELL_NO": {
      if (accounts.userNo === undefined) {
        throw new IntentError(`${intent} needs the user's NO token account`);
      }
      const noAccounts = {
        ...common,
        userNo: accounts.userNo,
        yesMint: accounts.market.yesMint,
        noMint: accounts.market.noMint,
        vault: accounts.market.vault,
      };
      const method =
        intent === "BUY_NO"
          ? program.methods.buyNo(qty, price, orderKindArg(kind))
          : program.methods.sellNo(qty, price);
      return method.accountsStrict(noAccounts).remainingAccounts(remaining).instruction();
    }
  }
}

/** A resting order as the NO view needs it: a price in cents plus whatever else the caller keeps. */
export type PricedOrder = { readonly price: number };

/** One side-by-side book of resting YES orders, best price first on each side. */
export type Book<T extends PricedOrder> = {
  readonly bids: readonly T[];
  readonly asks: readonly T[];
};

/**
 * The NO view of a YES book: YES asks become NO bids at 100 − p, YES bids become NO asks at
 * 100 − p. Order is kept (best first stays best first: the highest YES bid is the lowest NO ask).
 * It is its own exact inverse: `noViewOfBook(noViewOfBook(book))` equals `book`.
 */
export function noViewOfBook<T extends PricedOrder>(book: Book<T>): Book<T> {
  const flip = (order: T): T => ({ ...order, price: complementCents(order.price) });
  return { bids: book.asks.map(flip), asks: book.bids.map(flip) };
}
