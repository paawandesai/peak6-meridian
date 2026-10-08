/** Loads a wallet's program events from its recent transactions (read-only RPC). */
import { findOpenOrdersPda } from "@meridian/client";
import { PublicKey, type Connection } from "@solana/web3.js";

import { isWalletEvent } from "./history-model";
import { decodeEvents, type MeridianEvent } from "@/lib/events";
import type { MarketRow } from "@/lib/markets";

export const HISTORY_LIMIT = 50;

/** The slice of `Connection` this module uses, so tests can supply a fake. */
export type HistoryRpc = Pick<Connection, "getSignaturesForAddress" | "getTransactions">;

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
 * The newest transactions touching the wallet or any of `extraAddresses` (its OpenOrders PDAs),
 * merged by signature and decoded by `@/lib/events`. Failed transactions are skipped; events of
 * other wallets in the same transaction are dropped.
 */
export async function loadWalletEvents(
  rpc: HistoryRpc,
  wallet: PublicKey,
  programId: PublicKey,
  extraAddresses: readonly PublicKey[] = [],
  limit: number = HISTORY_LIMIT,
): Promise<MeridianEvent[]> {
  const lists = await Promise.all(
    [wallet, ...extraAddresses].map((address) => rpc.getSignaturesForAddress(address, { limit })),
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
