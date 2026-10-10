/** Read-only chain access for /status: vault balances and the creation/settle transactions. */
import { findVaultPda } from "@meridian/client";
import { PublicKey, type Connection } from "@solana/web3.js";
import { z } from "zod";

import { decodeEvents } from "@/lib/events";
import type { MarketRow } from "@/lib/markets";
import { factsFromEvents, NO_FACTS, type MarketFacts } from "@/lib/status";
import { getMultipleChunked } from "@/lib/rpc";

export type StatusRpc = Pick<
  Connection,
  "getMultipleParsedAccounts" | "getSignaturesForAddress" | "getTransactions"
>;

const SIGNATURE_PAGE = 1_000;
/** Only the newest trading dates are inspected, which bounds the RPC cost (7 markets per day). */
export const MAX_DAYS = 2;
/** Concurrent market-facts fetches to limit RPC burst. */
const CONCURRENCY_CAP = 4;

const tokenAccount = z.object({
  data: z.object({
    parsed: z.object({ info: z.object({ tokenAmount: z.object({ amount: z.string() }) }) }),
  }),
});

/** Vault USDC base units per market address; `null` for a vault that is missing or unreadable. */
export async function loadVaultBalances(
  rpc: StatusRpc,
  markets: readonly MarketRow[],
  programId: PublicKey,
): Promise<Map<string, bigint | null>> {
  const keys = markets.map((row) => findVaultPda(new PublicKey(row.address), programId).address);
  const value = await getMultipleChunked(rpc, keys, { commitment: "confirmed" });
  return new Map(
    markets.map((row, index) => {
      const parsed = tokenAccount.safeParse(value[index]);
      return [
        row.address,
        parsed.success ? BigInt(parsed.data.data.parsed.info.tokenAmount.amount) : null,
      ];
    }),
  );
}

/** Transactions fetched per request while looking for the settle transaction. */
const SETTLE_SCAN_BATCH = 8;
/** Newest-first transactions inspected at most; settlement is near the start of a market's tail. */
export const MAX_SETTLE_SCAN = 64;

type Signature = Awaited<ReturnType<StatusRpc["getSignaturesForAddress"]>>[number];

/** Fetches `entries` and folds their decoded events into facts (first value found wins). */
async function factsOf(
  rpc: StatusRpc,
  entries: readonly Signature[],
  programId: PublicKey,
): Promise<MarketFacts> {
  const txs = await rpc.getTransactions(
    entries.map((entry) => entry.signature),
    { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  );
  let facts = NO_FACTS;
  txs.forEach((tx, index) => {
    const entry = entries[index];
    const logs = tx?.meta?.logMessages;
    if (tx === null || entry === undefined || logs === null || logs === undefined) return;
    const events = decodeEvents(
      logs,
      { signature: entry.signature, blockTime: tx.blockTime ?? entry.blockTime ?? null },
      programId,
    );
    const found = factsFromEvents(events, tx.slot);
    facts = {
      createdAt: facts.createdAt ?? found.createdAt,
      settledAt: facts.settledAt ?? found.settledAt,
      settleSlot: facts.settleSlot ?? found.settleSlot,
      oracleSlot: facts.oracleSlot ?? found.oracleSlot,
    };
  });
  return facts;
}

/**
 * Creation and settle facts for one market. The oldest transaction is the creation (a full page
 * of signatures means it is not known, so it is left unknown rather than guessed). The settle
 * transaction is NOT the newest one: redeems, withdrawals and orders after settlement also list
 * the market account, so the newest transactions are scanned in batches until one emits
 * `MarketSettled` (at most `MAX_SETTLE_SCAN`; beyond that the metrics stay unavailable).
 * Returns `NO_FACTS` on any error (per-market error isolation for /status).
 */
export async function loadMarketFacts(
  rpc: StatusRpc,
  market: MarketRow,
  programId: PublicKey,
): Promise<MarketFacts> {
  try {
    const address = new PublicKey(market.address);
    const all = (await rpc.getSignaturesForAddress(address, { limit: SIGNATURE_PAGE })).filter(
      (entry) => entry.err === null,
    );
    const oldest = all.length < SIGNATURE_PAGE ? all.at(-1) : undefined;
    let facts = oldest === undefined ? NO_FACTS : await factsOf(rpc, [oldest], programId);
    if (!market.settled) return facts;
    const candidates = all.slice(0, MAX_SETTLE_SCAN);
    for (let at = 0; at < candidates.length && facts.settledAt === null; at += SETTLE_SCAN_BATCH) {
      const found = await factsOf(rpc, candidates.slice(at, at + SETTLE_SCAN_BATCH), programId);
      facts = {
        createdAt: facts.createdAt ?? found.createdAt,
        settledAt: found.settledAt,
        settleSlot: found.settleSlot,
        oracleSlot: found.oracleSlot,
      };
    }
    return facts;
  } catch {
    return NO_FACTS;
  }
}

/** Runs tasks in batches of `concurrency` at a time (serial within each batch). */
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

export type StatusData = {
  readonly markets: readonly MarketRow[];
  readonly vaults: ReadonlyMap<string, bigint | null>;
  readonly facts: ReadonlyMap<string, MarketFacts>;
};

/**
 * Everything the page needs for the newest `MAX_DAYS` trading dates. Only scans markets from
 * those dates to limit RPC load. Facts are fetched with concurrency cap and per-market error
 * isolation (a failed row shows "unavailable"; the page still renders).
 */
export async function loadStatusData(
  rpc: StatusRpc,
  all: readonly MarketRow[],
  programId: PublicKey,
): Promise<StatusData> {
  const dates = [...new Set(all.map((row) => row.tradingDate))].sort((a, b) => b - a);
  const markets = all.filter((row) => dates.slice(0, MAX_DAYS).includes(row.tradingDate));
  if (markets.length === 0) return { markets, vaults: new Map(), facts: new Map() };
  const [vaults, factsArray] = await Promise.all([
    loadVaultBalances(rpc, markets, programId),
    runWithConcurrency(markets, CONCURRENCY_CAP, async (row) => {
      const result = await loadMarketFacts(rpc, row, programId);
      return [row.address, result] as const;
    }),
  ]);
  return { markets, vaults, facts: new Map(factsArray) };
}
