/** Fixtures shared by the Trade page tests: events, books, readers and a recording fake. */
import { BorshCoder } from "@coral-xyz/anchor";
import { BN, MERIDIAN_IDL } from "@meridian/client";
import { PublicKey } from "@solana/web3.js";

import type { BookOrder, FullBook } from "./book-view";
import type { TradeReader, VaultReading, WalletView } from "./reader";
import type { SimulationOutcome, SubmitResult, TradeActions, TradeRequest } from "./tx";
import { decodeEvents, type MeridianEvent } from "@/lib/events";

export const key = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
export const USER = key(9);
export const MAKER_A = key(10);
export const MAKER_B = key(11);

const coder = new BorshCoder(MERIDIAN_IDL);

/** A `Program data:` log line for an event, built like `emit!` does. */
export function eventLog(name: string, data: object): string {
  const event = MERIDIAN_IDL.events?.find((candidate) => candidate.name === name);
  if (event === undefined) throw new Error(`no event ${name}`);
  const body = coder.types.encode(name, data);
  return `Program data: ${Buffer.concat([Buffer.from(event.discriminator), body]).toString("base64")}`;
}

export function fillLog(price: number, qty: number, taker: PublicKey = USER): string {
  return eventLog("Fill", {
    market: key(1),
    maker: MAKER_A,
    taker,
    price,
    qty: new BN(qty),
    taker_side: { Bid: {} },
  });
}

/** Program-log lines as a simulation reports them: events sit inside the program's invocation. */
export function programLogs(lines: readonly string[]): string[] {
  return [
    `Program ${MERIDIAN_IDL.address} invoke [1]`,
    ...lines,
    `Program ${MERIDIAN_IDL.address} success`,
  ];
}

/** Decoded Fill events for `[price, qty]` pairs, as the simulation would report them. */
export function fills(...pairs: readonly (readonly [number, number])[]): MeridianEvent[] {
  return decodeEvents(programLogs(pairs.map(([price, qty]) => fillLog(price, qty))), {
    signature: "sim",
  });
}

export function order(
  side: "bid" | "ask",
  price: number,
  qty: number,
  owner: PublicKey = MAKER_A,
  seq = 1,
): BookOrder {
  void side; // documents the call site; the book arrays decide the side
  return {
    orderId: BigInt(seq),
    owner: owner.toBase58(),
    price,
    qty: BigInt(qty),
    seq: BigInt(seq),
  };
}

export const BOOK: FullBook = {
  bids: [order("bid", 58, 30, MAKER_A, 1), order("bid", 57, 50, MAKER_B, 2)],
  asks: [order("ask", 61, 40, MAKER_A, 3), order("ask", 62, 25, MAKER_B, 4)],
};

export const EMPTY_WALLET: WalletView = {
  yes: 0n,
  no: 0n,
  usdc: 100_000_000n,
  freeUsdc: 0n,
  freeYes: 0n,
};

/** A passing vault: 1,240 pairs and exactly 1,240 × 1,000,000 base units. */
export const VAULT: VaultReading = {
  pairs: 1_240n,
  balance: 1_240_000_000n,
  asOfSecs: 1_791_486_000,
};

/**
 * A fake reader. Unless overridden, `getSnapshot` is `getBook` (the override's, if any) plus
 * {@link VAULT}, so tests that only replace `getBook` keep driving the page's book.
 */
export function fakeReader(overrides: Partial<TradeReader> = {}): TradeReader {
  const base = {
    getBook: () => Promise.resolve(BOOK),
    getWallet: () => Promise.resolve(EMPTY_WALLET),
    getOpenTime: () => Promise.resolve(null),
    ...overrides,
  };
  return {
    getSnapshot: async () => ({ book: await base.getBook(), vault: VAULT }),
    ...base,
  };
}

export type Call = { readonly name: string; readonly args: readonly unknown[] };

/** Records every call; `simulate` answers with `outcome`, submits with `result`. */
export function fakeActions(
  outcome: SimulationOutcome | ((request: TradeRequest) => SimulationOutcome) = {
    ok: true,
    events: [],
  },
  result: SubmitResult = { signature: "SigFake", slot: 123 },
): { actions: TradeActions; calls: Call[] } {
  const calls: Call[] = [];
  const record = (name: string, args: readonly unknown[]): void => {
    calls.push({ name, args });
  };
  const actions: TradeActions = {
    simulate: (request) => {
      record("simulate", [request]);
      return Promise.resolve(typeof outcome === "function" ? outcome(request) : outcome);
    },
    trade: (request, onPhase) => {
      record("trade", [request]);
      onPhase?.("awaiting-signature");
      onPhase?.("confirming");
      return Promise.resolve(result);
    },
    cancel: (orderId) => {
      record("cancel", [orderId]);
      return Promise.resolve(result);
    },
    withdraw: () => {
      record("withdraw", []);
      return Promise.resolve(result);
    },
    redeemPair: (qty) => {
      record("redeemPair", [qty]);
      return Promise.resolve(result);
    },
    redeemWinner: (yes, no) => {
      record("redeemWinner", [yes, no]);
      return Promise.resolve(result);
    },
  };
  return { actions, calls };
}
