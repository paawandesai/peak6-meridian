/**
 * Read-only chain access for the Trade page: the full book and the wallet's balances and
 * open-orders account; the market's creation time comes from the automation creation-time index
 * (P1-4), never from a per-market signature scan. `TradeReader` is the seam the page and its
 * tests use.
 */
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  createMeridianProgram,
  findConfigPda,
  findOpenOrdersPda,
  marketAddresses,
} from "@meridian/client";
import { type Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { type AccountFeed, type LiveSource, liveSource } from "@/lib/account-feed";
import { sharedAccountFeed, sharedConnection } from "@/lib/rpc";

import type { BookOrder, FullBook } from "./book-view";
import type { PublicConfig } from "@/lib/config";
import { fetchOpenTimes, openTimeOf, type OpenTime, type OpenTimes } from "@/lib/open-times-core";
import type { MarketRow } from "@/lib/markets";

export type WalletView = {
  readonly yes: bigint;
  readonly no: bigint;
  /** Test-USDC base units in the wallet. */
  readonly usdc: bigint;
  /** Free balances in the open-orders account, withdrawn with `settle_funds`. */
  readonly freeUsdc: bigint;
  readonly freeYes: bigint;
};

/** The vault invariant inputs, read in the same RPC call as the book (P0-7, FR-29). */
export type VaultReading = {
  /** `Market.pairs_outstanding`, or `null` when the market account could not be decoded. */
  readonly pairs: bigint | null;
  /** The vault's USDC base units, or `null` when the vault is missing or unreadable. */
  readonly balance: bigint | null;
  /** Unix seconds (client clock) the read returned. */
  readonly asOfSecs: number;
};

export type TradeSnapshot = { readonly book: FullBook; readonly vault: VaultReading };

export type TradeReader = {
  getBook(): Promise<FullBook>;
  /**
   * The book plus the vault invariant inputs in ONE `getMultipleAccountsInfo` call, so the Trade
   * page's existing book poll carries the vault chip at no extra request.
   */
  getSnapshot(): Promise<TradeSnapshot>;
  getWallet(owner: PublicKey): Promise<WalletView>;
  /**
   * When the market was created (D-050): unix seconds, `null` when the index has no record, or
   * `"unavailable"` while the index is rebuilding. Rejects when the index cannot be read.
   */
  getOpenTime(): Promise<OpenTime>;
  /**
   * P1-2: the snapshot pushed by account subscriptions on the shared feed, polled every
   * `fastMs` only while push is unavailable. Absent on test fakes, which are polled.
   */
  snapshotSource?(fastMs: number): LiveSource<TradeSnapshot>;
  /** P1-2: the wallet view (3 ATAs + open orders) on the shared feed. */
  walletSource?(owner: PublicKey, fastMs: number): LiveSource<WalletView>;
};

type RawOrder = {
  orderId: { toString(): string };
  owner: PublicKey;
  price: number;
  qty: { toString(): string };
  seq: { toString(): string };
};

/** Decodes the 32+32 slots of a `Book` account; empty slots (`qty == 0`) are dropped. */
export function decodeBook(raw: {
  bids: readonly RawOrder[];
  asks: readonly RawOrder[];
}): FullBook {
  const side = (orders: readonly RawOrder[]): BookOrder[] =>
    orders
      .map((order) => ({
        orderId: BigInt(order.orderId.toString()),
        owner: order.owner.toBase58(),
        price: order.price,
        qty: BigInt(order.qty.toString()),
        seq: BigInt(order.seq.toString()),
      }))
      .filter((order) => order.qty > 0n);
  return { bids: side(raw.bids), asks: side(raw.asks) };
}

/** SPL token account `amount` (u64 LE at offset 64), or `null` for a missing or short account. */
export function splAmount(data: Uint8Array | null | undefined): bigint | null {
  if (data === null || data === undefined || data.length < 72) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buf.readBigUInt64LE(64);
}

type AccountData = { readonly data: Uint8Array } | null | undefined;
type DecodeAccount = (name: "book" | "market", data: Buffer) => unknown;

/**
 * Decodes `[book, market, vault]` account infos from one multi-account read. A missing book is an
 * error (the page shows it); a missing or undecodable market or vault only makes the vault chip
 * read "unavailable", never a guessed number.
 */
export function decodeSnapshot(
  [bookInfo, marketInfo, vaultInfo]: readonly [AccountData, AccountData, AccountData],
  decode: DecodeAccount,
  asOfSecs: number,
): TradeSnapshot {
  if (bookInfo === null || bookInfo === undefined) throw new Error("book account not found");
  const toBuf = (data: Uint8Array): Buffer => (Buffer.isBuffer(data) ? data : Buffer.from(data));
  const book = decodeBook(decode("book", toBuf(bookInfo.data)) as Parameters<typeof decodeBook>[0]);
  let pairs: bigint | null = null;
  if (marketInfo !== null && marketInfo !== undefined) {
    try {
      const market = decode("market", toBuf(marketInfo.data)) as {
        pairsOutstanding?: { toString(): string };
      };
      pairs =
        market.pairsOutstanding === undefined ? null : BigInt(market.pairsOutstanding.toString());
    } catch {
      pairs = null;
    }
  }
  return { book, vault: { pairs, balance: splAmount(vaultInfo?.data), asOfSecs } };
}

/** SPL token `amount` of a wallet token account; missing is 0, a short account is an error. */
function tokenBalance(data: AccountData): bigint {
  if (data === null || data === undefined) return 0n;
  const amount = splAmount(data.data);
  if (amount === null) throw new Error("SPL token account data too short");
  return amount;
}

/**
 * Decodes `[yesAta, noAta, usdcAta, openOrders]` into the wallet view. Missing accounts are zero;
 * a short token account or an undecodable open-orders account throws, so Trade fails closed
 * (holdings unknown) instead of trading on a guessed balance.
 */
export function decodeWallet(
  [yesInfo, noInfo, usdcInfo, ooInfo]: readonly [
    AccountData,
    AccountData,
    AccountData,
    AccountData,
  ],
  decodeOpenOrders: (data: Buffer) => {
    freeUsdc: { toString(): string };
    freeYes: { toString(): string };
  },
): WalletView {
  let freeUsdc = 0n;
  let freeYes = 0n;
  if (ooInfo !== null && ooInfo !== undefined) {
    const data = Buffer.isBuffer(ooInfo.data) ? ooInfo.data : Buffer.from(ooInfo.data);
    const decoded = decodeOpenOrders(data);
    freeUsdc = BigInt(decoded.freeUsdc.toString());
    freeYes = BigInt(decoded.freeYes.toString());
  }
  return {
    yes: tokenBalance(yesInfo),
    no: tokenBalance(noInfo),
    usdc: tokenBalance(usdcInfo),
    freeUsdc,
    freeYes,
  };
}

/** Raw bytes from the feed as the `{ data }` shape the decoders take (`null` stays missing). */
const asInfos = (data: readonly (Uint8Array | null)[]): AccountData[] =>
  data.map((bytes) => (bytes === null ? null : { data: bytes }));

/** The market's open time from the automation creation-time index (one request, P1-4). */
export async function fetchOpenTime(
  market: string,
  read: () => Promise<OpenTimes> = () => fetchOpenTimes(),
): Promise<OpenTime> {
  return openTimeOf(await read(), market);
}

const readOnlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("read-only client cannot sign")),
  signAllTransactions: () => Promise.reject(new Error("read-only client cannot sign")),
};

/** Test seams: the connection, the account feed and the open-time index default to the app's. */
export type TradeReaderDeps = {
  readonly connection?: Connection;
  readonly feed?: AccountFeed;
  readonly readOpenTimes?: () => Promise<OpenTimes>;
};

export function createTradeReader(
  config: PublicConfig,
  row: MarketRow,
  deps: TradeReaderDeps = {},
): TradeReader {
  const connection = deps.connection ?? sharedConnection(config.rpcUrl);
  const feed = (): AccountFeed => deps.feed ?? sharedAccountFeed(config.rpcUrl);
  const readOpenTimes = deps.readOpenTimes ?? (() => fetchOpenTimes());
  const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" });
  const program = createMeridianProgram(provider, config.programId);
  const addresses = marketAddresses(
    { symbol: row.ticker, tradingDate: row.tradingDate, strikeCents: row.strikeCents },
    config.programId,
  );
  const market = new PublicKey(row.address);
  let usdcMint: Promise<PublicKey> | undefined;
  const mint = (): Promise<PublicKey> => {
    usdcMint ??= config.usdcMint
      ? Promise.resolve(config.usdcMint)
      : program.account.config
          .fetch(findConfigPda(config.programId).address)
          .then((c) => c.usdcMint);
    return usdcMint;
  };
  const snapshotKeys = [addresses.book, market, addresses.vault];
  const decodeAccount: DecodeAccount = (name, data) => program.coder.accounts.decode(name, data);
  const decodeOpenOrders = (data: Buffer) => program.coder.accounts.decode("openOrders", data);
  // One getMultipleAccounts for the 3 ATAs + OpenOrders (P0-4); the same keys feed walletSource.
  const walletKeys = async (owner: PublicKey): Promise<PublicKey[]> => {
    const oo = findOpenOrdersPda(market, owner, config.programId).address;
    const usdc = await mint();
    const [yesAta, noAta, usdcAta] = await Promise.all([
      getAssociatedTokenAddress(addresses.yesMint, owner),
      getAssociatedTokenAddress(addresses.noMint, owner),
      getAssociatedTokenAddress(usdc, owner),
    ]);
    return [yesAta, noAta, usdcAta, oo];
  };
  return {
    async getBook() {
      return decodeBook(await program.account.book.fetch(addresses.book));
    },
    async getSnapshot() {
      const infos = await connection.getMultipleAccountsInfo(snapshotKeys, "confirmed");
      return decodeSnapshot(
        [infos[0], infos[1], infos[2]],
        decodeAccount,
        Math.floor(Date.now() / 1000),
      );
    },
    async getWallet(owner) {
      const accounts = await connection.getMultipleAccountsInfo(await walletKeys(owner));
      return decodeWallet([accounts[0], accounts[1], accounts[2], accounts[3]], decodeOpenOrders);
    },
    getOpenTime: () => fetchOpenTime(row.address, readOpenTimes),
    snapshotSource: (fastMs) =>
      liveSource(
        feed(),
        snapshotKeys.map((key) => key.toBase58()),
        fastMs,
        (data, checkedAt) => {
          const [book, marketInfo, vault] = asInfos(data);
          return decodeSnapshot(
            [book, marketInfo, vault],
            decodeAccount,
            Math.floor(checkedAt / 1000),
          );
        },
      ),
    walletSource: (owner, fastMs) =>
      liveSource(
        feed(),
        async () => (await walletKeys(owner)).map((key) => key.toBase58()),
        fastMs,
        (data) => {
          const [yes, no, usdc, oo] = asInfos(data);
          return decodeWallet([yes, no, usdc, oo], decodeOpenOrders);
        },
      ),
  };
}
