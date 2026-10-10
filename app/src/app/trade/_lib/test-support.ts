/** Fixtures shared by the Trade page tests: events, books, readers and a recording fake. */
import { BorshCoder } from "@coral-xyz/anchor";
import { BN, findOpenOrdersPda, marketAddresses, MERIDIAN_IDL } from "@meridian/client";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { type Connection, Keypair, PublicKey } from "@solana/web3.js";

import type { BookOrder, FullBook } from "./book-view";
import type { TradeReader, VaultReading, WalletView } from "./reader";
import type { SimulationOutcome, SubmitResult, TradeActions, TradeRequest } from "./tx";
import { decodeEvents, type MeridianEvent } from "@/lib/events";
import type { PublicConfig } from "@/lib/config";
import type { MarketRow } from "@/lib/markets";

export const key = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
export const USER = key(9);
export const MAKER_A = key(10);
export const MAKER_B = key(11);
/** An on-curve wallet (token accounts can only be derived for one). */
export const WALLET_OWNER = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;

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

/** On-chain bytes of a `Book` (bytemuck: 8-byte discriminator, 32 bids, 32 asks of 64 bytes). */
export function encodeBook(
  bids: readonly (readonly [number, number])[],
  asks: readonly (readonly [number, number])[],
): Buffer {
  const discriminator = MERIDIAN_IDL.accounts?.find((a) => a.name === "Book")?.discriminator ?? [];
  const buf = Buffer.alloc(8 + 64 * 64 + 48);
  Buffer.from(discriminator).copy(buf, 0);
  const side = (orders: readonly (readonly [number, number])[], base: number) =>
    orders.forEach(([price, qty], i) => {
      const at = base + i * 64;
      buf.writeBigUInt64LE(BigInt(i + 1), at); // order_id
      MAKER_A.toBuffer().copy(buf, at + 8); // owner
      buf.writeUInt8(price, at + 40);
      buf.writeBigUInt64LE(BigInt(qty), at + 48);
      buf.writeBigUInt64LE(BigInt(i + 1), at + 56); // seq
    });
  side(bids, 8);
  side(asks, 8 + 32 * 64);
  return buf;
}

/** On-chain bytes of a `Market` with `pairs` outstanding. */
export function encodeMarket(pairs: number): Promise<Buffer> {
  return coder.accounts.encode("Market", {
    ticker: [65, 65, 80, 76, 0, 0, 0, 0],
    strike_cents: new BN(22_000),
    trading_date: 20261008,
    close_ts: new BN(2_000_000_000),
    yes_mint: key(2),
    no_mint: key(3),
    vault: key(4),
    escrow_usdc: key(5),
    escrow_yes: key(6),
    book: key(7),
    pairs_outstanding: new BN(pairs),
    status: { Open: {} },
    outcome: { None: {} },
    settle_price_scaled: new BN(0),
    settle_slot: new BN(0),
    settled_at: new BN(0),
    settle_source: { None: {} },
    bump: 1,
  });
}

/** On-chain bytes of an `OpenOrders` account. */
export function encodeOpenOrders(freeUsdc: number, freeYes: number): Promise<Buffer> {
  return coder.accounts.encode("OpenOrders", {
    owner: USER,
    market: key(1),
    free_usdc: new BN(freeUsdc),
    free_yes: new BN(freeYes),
    resting_count: 0,
    bump: 1,
  });
}

/** A 165-byte SPL token account holding `amount` (u64 LE at offset 64). */
export function encodeTokenAccount(amount: bigint): Buffer {
  const buf = Buffer.alloc(165);
  buf.writeBigUInt64LE(amount, 64);
  return buf;
}

/** A market row whose address is the real market PDA of its ticker, date and strike. */
export function pdaMarket(
  config: PublicConfig,
  ticker: string,
  strikeCents: bigint,
  overrides: Partial<MarketRow> = {},
): MarketRow {
  const tradingDate = overrides.tradingDate ?? 20261008;
  const { market } = marketAddresses(
    { symbol: ticker, tradingDate, strikeCents },
    config.programId,
  );
  return {
    address: market.toBase58(),
    ticker,
    tradingDate,
    strikeCents,
    closeTs: 2_000_000_000n,
    settled: false,
    outcome: "None",
    settlePriceScaled: 0n,
    pairsOutstanding: 1_240n,
    settledAt: 0n,
    ...overrides,
  };
}

type Levels = readonly (readonly [number, number])[];

/**
 * A fake chain behind a counting `Connection`: every market in `rows` has a book (bid 58 / ask
 * 61), a market account with 1,240 pairs and a matching vault; `owner` holds YES, NO and
 * test-USDC plus an open-orders account in each market. `counts` tallies every RPC request, the
 * number the P1-2 budget is about.
 */
export async function fakeChain(
  config: PublicConfig,
  rows: readonly MarketRow[],
  owner: PublicKey = WALLET_OWNER,
) {
  const accounts = new Map<string, Buffer>();
  const usdcMint = config.usdcMint ?? key(8);
  const marketBytes = await encodeMarket(1_240);
  const openOrders = await encodeOpenOrders(2_000_000, 3);
  const ata = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner).toBase58();
  const addressesOf = (row: MarketRow) =>
    marketAddresses(
      { symbol: row.ticker, tradingDate: row.tradingDate, strikeCents: row.strikeCents },
      config.programId,
    );
  accounts.set(ata(usdcMint), encodeTokenAccount(100_000_000n));
  for (const row of rows) {
    const addrs = addressesOf(row);
    accounts.set(addrs.book.toBase58(), encodeBook([[58, 30]], [[61, 40]]));
    accounts.set(row.address, marketBytes);
    accounts.set(addrs.vault.toBase58(), encodeTokenAccount(1_240_000_000n));
    accounts.set(ata(addrs.yesMint), encodeTokenAccount(5n));
    accounts.set(ata(addrs.noMint), encodeTokenAccount(0n));
    accounts.set(
      findOpenOrdersPda(addrs.market, owner, config.programId).address.toBase58(),
      openOrders,
    );
  }
  const counts = { total: 0, byMethod: {} as Record<string, number> };
  let slot = 100;
  const count = (method: string): void => {
    counts.total += 1;
    counts.byMethod[method] = (counts.byMethod[method] ?? 0) + 1;
  };
  const info = (k: PublicKey) => {
    const data = accounts.get(k.toBase58());
    return data === undefined
      ? null
      : { data, executable: false, lamports: 1, owner: PublicKey.default, rentEpoch: 0 };
  };
  const fake = {
    getMultipleAccountsInfo: (keys: PublicKey[]) => {
      count("getMultipleAccounts");
      return Promise.resolve(keys.map(info));
    },
    getMultipleAccountsInfoAndContext: (keys: PublicKey[]) => {
      count("getMultipleAccounts");
      slot += 1;
      return Promise.resolve({ context: { slot }, value: keys.map(info) });
    },
    getSignaturesForAddress: () => {
      count("getSignaturesForAddress");
      return Promise.resolve([]);
    },
  };
  return {
    connection: fake as unknown as Connection,
    counts,
    accounts,
    /** Replaces a market's book bytes (an order rests or fills); returns the book address. */
    setBook(row: MarketRow, bids: Levels, asks: Levels): string {
      const book = addressesOf(row).book.toBase58();
      accounts.set(book, encodeBook(bids, asks));
      return book;
    },
  };
}
