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
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { sharedConnection } from "@/lib/rpc";

import type { BookOrder, FullBook } from "./book-view";
import type { PublicConfig } from "@/lib/config";
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
      // P0-4: fetch 3 ATAs + OpenOrders in one getMultipleAccounts call
      const oo = findOpenOrdersPda(market, owner, config.programId).address;
      const usdcMint = await mint();
      const [yesAta, noAta, usdcAta] = await Promise.all([
        getAssociatedTokenAddress(addresses.yesMint, owner),
        getAssociatedTokenAddress(addresses.noMint, owner),
        getAssociatedTokenAddress(usdcMint, owner),
      ]);

      const accounts = await connection.getMultipleAccountsInfo([yesAta, noAta, usdcAta, oo]);

      // Parse token accounts (accounts 0-2). SPL token layout: amount at offset 64 (u64 LE).
      // Throw on decode failures so Trade's fail-closed logic (holdings = null) triggers.
      const parseTokenBalance = (accountInfo: (typeof accounts)[0]): bigint => {
        if (!accountInfo) return 0n;
        const data = accountInfo.data;
        if (data.length < 72) {
          throw new Error("SPL token account data too short");
        }
        // data might be Uint8Array (no readBigUInt64LE), convert to Buffer
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        return buf.readBigUInt64LE(64);
      };

      const yes = parseTokenBalance(accounts[0] ?? null);
      const no = parseTokenBalance(accounts[1] ?? null);
      const usdc = parseTokenBalance(accounts[2] ?? null);

      // Parse OpenOrders account (account 3). Let decode failures throw.
      const ooAccount = accounts[3];
      let freeUsdc = 0n;
      let freeYes = 0n;
      if (ooAccount) {
        // Program camelCases IDL account names: "openOrders" not "OpenOrders"
        const data = Buffer.isBuffer(ooAccount.data) ? ooAccount.data : Buffer.from(ooAccount.data);
        const decoded = program.coder.accounts.decode("openOrders", data);
        freeUsdc = BigInt(decoded.freeUsdc.toString());
        freeYes = BigInt(decoded.freeYes.toString());
      }

      return { yes, no, usdc, freeUsdc, freeYes };
    },
    getOpenTime: () => fetchOpenTime(connection, market),
  };
}
