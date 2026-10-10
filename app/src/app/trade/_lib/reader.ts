/**
 * Read-only chain access for the Trade page: the full book, the wallet's balances and open-orders
 * account, and the market's creation time. `TradeReader` is the seam the page and its tests use.
 */
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  createMeridianProgram,
  findConfigPda,
  findOpenOrdersPda,
  marketAddresses,
} from "@meridian/client";
import { type Connection, PublicKey } from "@solana/web3.js";
import { sharedConnection } from "@/lib/rpc";

import type { BookOrder, FullBook } from "./book-view";
import type { PublicConfig } from "@/lib/config";
import { fetchUsdcBalance } from "@/lib/chain";
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

export type TradeReader = {
  getBook(): Promise<FullBook>;
  getWallet(owner: PublicKey): Promise<WalletView>;
  /** Unix seconds the market was created, or `null` when it cannot be read. */
  getOpenTime(): Promise<number | null>;
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

const SIGNATURE_PAGE = 1_000;
const MAX_PAGES = 5;

/**
 * The block time of the market's oldest transaction (its creation). `getSignaturesForAddress`
 * returns newest first, so this pages back until a short page; `null` when the history is too
 * long to walk cheaply (`MAX_PAGES`) or the cluster reports no block time.
 */
export async function fetchOpenTime(
  connection: Pick<Connection, "getSignaturesForAddress">,
  market: PublicKey,
): Promise<number | null> {
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await connection.getSignaturesForAddress(
      market,
      before === undefined ? { limit: SIGNATURE_PAGE } : { limit: SIGNATURE_PAGE, before },
      "confirmed",
    );
    const oldest = batch[batch.length - 1];
    if (oldest === undefined) return null;
    if (batch.length < SIGNATURE_PAGE) return oldest.blockTime ?? null;
    before = oldest.signature;
  }
  return null;
}

const readOnlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("read-only client cannot sign")),
  signAllTransactions: () => Promise.reject(new Error("read-only client cannot sign")),
};

export function createTradeReader(config: PublicConfig, row: MarketRow): TradeReader {
  const connection = sharedConnection(config.rpcUrl);
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
  return {
    async getBook() {
      return decodeBook(await program.account.book.fetch(addresses.book));
    },
    async getWallet(owner) {
      const oo = findOpenOrdersPda(market, owner, config.programId).address;
      const [yes, no, usdc, account] = await Promise.all([
        fetchUsdcBalance(connection, owner, addresses.yesMint),
        fetchUsdcBalance(connection, owner, addresses.noMint),
        mint().then((m) => fetchUsdcBalance(connection, owner, m)),
        program.account.openOrders.fetchNullable(oo),
      ]);
      return {
        yes,
        no,
        usdc,
        freeUsdc: account === null ? 0n : BigInt(account.freeUsdc.toString()),
        freeYes: account === null ? 0n : BigInt(account.freeYes.toString()),
      };
    },
    getOpenTime: () => fetchOpenTime(connection, market),
  };
}
