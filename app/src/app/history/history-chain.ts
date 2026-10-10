/** Loads a wallet's program events from its recent transactions (read-only RPC). */
import { findOpenOrdersPda } from "@meridian/client";
import { PublicKey, type Connection } from "@solana/web3.js";

import { isWalletEvent } from "./history-model";
import { decodeEvents, type MeridianEvent } from "@/lib/events";
import type { MarketRow } from "@/lib/markets";

export const HISTORY_LIMIT = 50;
/** Concurrent signature fetches to limit RPC burst. */
const CONCURRENCY_CAP = 4;

/** The slice of `Connection` this module uses, so tests can supply a fake. */
export type HistoryRpc = Pick<
  Connection,
  "getSignaturesForAddress" | "getTransactions" | "getProgramAccounts"
>;

/**
 * The wallet's OpenOrders PDA in each market. A resting order that is filled or cancelled by the
 * engine appears only in the taker's transaction, which lists this PDA and not the maker wallet,
 * so these addresses must be scanned too for maker fills (US-10).
 */
export function openOrdersAddresses(
  markets: readonly MarketRow[],
  wallet: PublicKey,
  programId: PublicKey,
): PublicKey[] {
  return markets.map(
    (row) => findOpenOrdersPda(new PublicKey(row.address), wallet, programId).address,
  );
}

/**
 * Finds all OpenOrders accounts owned by `wallet` using one getProgramAccounts call with an owner
 * memcmp filter. This avoids scanning every market's potential OpenOrders PDA when most don't exist.
 * OpenOrders account layout: 8-byte discriminator, then 32-byte owner pubkey at offset 8.
 */
export async function findWalletOpenOrders(
  rpc: Pick<Connection, "getProgramAccounts">,
  wallet: PublicKey,
  programId: PublicKey,
): Promise<PublicKey[]> {
  try {
    const accounts = await rpc.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters: [
        { dataSize: 73 }, // OpenOrders account size
        { memcmp: { offset: 8, bytes: wallet.toBase58() } }, // owner field at offset 8
      ],
    });
    return accounts.map(({ pubkey }) => pubkey);
  } catch {
    // If getProgramAccounts fails, fall back to empty (history will show only wallet txs)
    return [];
  }
}

/** Runs tasks in batches of `concurrency` at a time. */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(task));
    results.push(...batchResults);
  }
  return results;
}

/**
 * The newest transactions touching the wallet or any of `extraAddresses` (its OpenOrders PDAs),
 * merged by signature and decoded by `@/lib/events`. Failed transactions are skipped; events of
 * other wallets in the same transaction are dropped.
 * Uses getProgramAccounts to find the wallet's OpenOrders (one RPC call with owner memcmp) instead
 * of scanning all potential market PDAs, with concurrency cap on signature fetches.
 */
export async function loadWalletEvents(
  rpc: HistoryRpc,
  wallet: PublicKey,
  programId: PublicKey,
  extraAddresses: readonly PublicKey[] = [],
  limit: number = HISTORY_LIMIT,
): Promise<MeridianEvent[]> {
  // Find the wallet's OpenOrders accounts (one gPA call with owner filter)
  const ooAddresses =
    extraAddresses.length > 0 ? extraAddresses : await findWalletOpenOrders(rpc, wallet, programId);
  // Fetch signatures with concurrency cap
  const lists = await runWithConcurrency(
    [wallet, ...ooAddresses],
    CONCURRENCY_CAP,
    (address) => rpc.getSignaturesForAddress(address, { limit }),
  );
  const unique = new Map(lists.flat().map((entry) => [entry.signature, entry]));
  const signatures = [...unique.values()]
    .filter((entry) => entry.err === null)
    .sort((a, b) => b.slot - a.slot)
    .slice(0, limit);
  if (signatures.length === 0) return [];
  const txs = await rpc.getTransactions(
    signatures.map((entry) => entry.signature),
    { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  );
  const me = wallet.toBase58();
  const out: MeridianEvent[] = [];
  txs.forEach((tx, index) => {
    const entry = signatures[index];
    const logs = tx?.meta?.logMessages;
    if (entry === undefined || tx === null || logs === null || logs === undefined) return;
    const events = decodeEvents(
      logs,
      { signature: entry.signature, blockTime: tx.blockTime ?? entry.blockTime ?? null },
      programId,
    );
    out.push(...events.filter((event) => isWalletEvent(event, me)));
  });
  return out;
}
