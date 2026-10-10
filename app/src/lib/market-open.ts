/**
 * When each market opened (D-050): the block time of its creation transaction, i.e. the oldest
 * signature of the market account (the `MarketCreated` event is emitted in that transaction).
 * The program has no open gate; "open" is creation. Read-only; results never change once known,
 * so they are cached per address for the life of the page plus sessionStorage (P0-4).
 */
import { type Connection, PublicKey } from "@solana/web3.js";
import { sharedConnection } from "@/lib/rpc";

import type { PublicConfig } from "./config";

/** Unix seconds of the creation transaction per market address; `null` when it cannot be read. */
export type OpenTimeSource = (
  addresses: readonly string[],
) => Promise<Record<string, number | null>>;

const PAGE = 1_000;
const MAX_PAGES = 5;
const CONCURRENCY_CAP = 4;
const STORAGE_KEY = "meridian:market-open-times";

type SignaturesApi = Pick<Connection, "getSignaturesForAddress">;

/** Load cached times from sessionStorage. */
function loadFromStorage(): Map<string, number | null> {
  if (typeof window === "undefined") return new Map();
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return new Map();
    return new Map(Object.entries(JSON.parse(stored)));
  } catch {
    return new Map();
  }
}

/** Save cached times to sessionStorage. */
function saveToStorage(cache: Map<string, number | null>): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Storage full or disabled, ignore
  }
}

/** Block time of the oldest transaction that touched `address`, or `null`. */
export async function creationBlockTime(
  connection: SignaturesApi,
  address: PublicKey,
): Promise<number | null> {
  let before: string | undefined;
  let oldest: { signature: string; blockTime?: number | null } | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await connection.getSignaturesForAddress(
      address,
      { limit: PAGE, ...(before === undefined ? {} : { before }) },
      "confirmed",
    );
    // An empty page after a full one means the previous page ended at the creation transaction.
    if (batch.length === 0) return oldest?.blockTime ?? null;
    oldest = batch[batch.length - 1];
    if (batch.length < PAGE) return oldest?.blockTime ?? null;
    before = oldest?.signature;
  }
  // More history than the pages read: the oldest entry seen is not the creation, so say unknown.
  return null;
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

export function createOpenTimeSource(
  config: PublicConfig,
  connection: SignaturesApi = sharedConnection(config.rpcUrl),
): OpenTimeSource {
  // Load from sessionStorage on first call
  const cache = loadFromStorage();
  return async (addresses) => {
    const out: Record<string, number | null> = {};
    const toFetch: string[] = [];

    // Check cache first
    for (const address of addresses) {
      if (cache.has(address)) {
        out[address] = cache.get(address) ?? null;
      } else {
        toFetch.push(address);
      }
    }

    if (toFetch.length === 0) return out;

    // Fetch with concurrency cap
    await runWithConcurrency(toFetch, CONCURRENCY_CAP, async (address) => {
      let time: number | null = null;
      try {
        time = await creationBlockTime(connection, new PublicKey(address));
      } catch {
        out[address] = null; // not cached: a failed read is retried on the next poll
        return;
      }
      if (time !== null) {
        cache.set(address, time);
        out[address] = time;
      } else {
        out[address] = null;
      }
    });

    // Save to sessionStorage after fetching
    saveToStorage(cache);
    return out;
  };
}
