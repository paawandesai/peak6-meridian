/** Read-only order-book quotes for the app: a thin wiring of `@meridian/client`'s book decoding. */
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  bookAccountApi,
  type BookQuotes,
  createMeridianProgram,
  fetchBookQuotes,
} from "@meridian/client";
import { PublicKey } from "@solana/web3.js";
import { sharedConnection } from "@/lib/rpc";

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

/** One `getMultipleAccounts` call per poll, decoded by the generated client. */
export function createBookSource(config: PublicConfig): BookSource {
  const connection = sharedConnection(config.rpcUrl);
  const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" });
  const program = createMeridianProgram(provider, config.programId);
  const books = bookAccountApi(program);
  return (markets) => fetchBookQuotes(books, markets, config.programId);
}
