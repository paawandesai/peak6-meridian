/** Loads a wallet's program events from its recent transactions (read-only RPC). */
import type { Connection, PublicKey } from "@solana/web3.js";

import { isWalletEvent } from "./history-model";
import { decodeEvents, type MeridianEvent } from "@/lib/events";

export const HISTORY_LIMIT = 50;

/** The slice of `Connection` this module uses, so tests can supply a fake. */
export type HistoryRpc = Pick<Connection, "getSignaturesForAddress" | "getTransactions">;

/**
 * The wallet's newest transactions' program events, decoded by `@/lib/events`. Failed
 * transactions emit nothing that happened, so they are skipped; events of other wallets in the
 * same transaction are dropped.
 */
export async function loadWalletEvents(
  rpc: HistoryRpc,
  wallet: PublicKey,
  programId: PublicKey,
  limit: number = HISTORY_LIMIT,
): Promise<MeridianEvent[]> {
  const signatures = (await rpc.getSignaturesForAddress(wallet, { limit })).filter(
    (entry) => entry.err === null,
  );
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
