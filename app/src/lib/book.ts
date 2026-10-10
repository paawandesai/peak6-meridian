/** Read-only order-book quotes for the app: a thin wiring of `@meridian/client`'s book decoding. */
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  bookAccountApi,
  type BookLike,
  type BookQuotes,
  bookQuotes,
  createMeridianProgram,
  fetchBookQuotes,
  findBookPda,
} from "@meridian/client";
import { type Connection, PublicKey } from "@solana/web3.js";
import { type AccountFeed, type LiveSource, liveSource } from "@/lib/account-feed";
import { sharedAccountFeed, sharedConnection } from "@/lib/rpc";

import type { PublicConfig } from "./config";

/** Quotes for several markets keyed by market address; `null` when a book cannot be read. */
export type BookSource = (
  markets: readonly PublicKey[],
) => Promise<Record<string, BookQuotes | null>>;

const readOnlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("read-only client cannot sign")),
  signAllTransactions: () => Promise.reject(new Error("read-only client cannot sign")),
};

/** Chunked book reads (≤99 keys per RPC call) per poll, decoded by the generated client. */
export function createBookSource(
  config: PublicConfig,
  connection: Connection = sharedConnection(config.rpcUrl),
): BookSource {
  const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" });
  const program = createMeridianProgram(provider, config.programId);
  const books = bookAccountApi(program);
  return (markets) => fetchBookQuotes(books, markets, config.programId);
}

/** P1-2: quotes for several markets pushed by account subscriptions on the shared feed. */
export type LiveBookSource = (
  markets: readonly PublicKey[],
  fastMs: number,
) => LiveSource<Record<string, BookQuotes | null>>;

/**
 * Book quotes on the account feed: one subscription per book account, decoded from the pushed
 * bytes, so a quote change costs no request. A missing or undecodable book is `null`
 * (unavailable), never a guessed quote.
 */
export function createLiveBookSource(
  config: PublicConfig,
  feed: AccountFeed = sharedAccountFeed(config.rpcUrl),
  connection: Connection = sharedConnection(config.rpcUrl),
): LiveBookSource {
  const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" });
  const program = createMeridianProgram(provider, config.programId);
  const quotesOf = (data: Uint8Array | null): BookQuotes | null => {
    if (data === null) return null;
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      return bookQuotes(program.coder.accounts.decode<BookLike>("book", buf));
    } catch {
      return null;
    }
  };
  return (markets, fastMs) =>
    liveSource(
      feed,
      markets.map((market) => findBookPda(market, config.programId).address.toBase58()),
      fastMs,
      (data) =>
        Object.fromEntries(
          markets.map((market, i) => [market.toBase58(), quotesOf(data[i] ?? null)]),
        ),
    );
}
