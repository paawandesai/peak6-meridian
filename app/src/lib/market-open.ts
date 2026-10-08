/**
 * When each market opened (D-050): the block time of its creation transaction, i.e. the oldest
 * signature of the market account (the `MarketCreated` event is emitted in that transaction).
 * The program has no open gate; "open" is creation. Read-only; results never change once known,
 * so they are cached per address for the life of the page.
 */
import { Connection, PublicKey } from "@solana/web3.js";

import type { PublicConfig } from "./config";

/** Unix seconds of the creation transaction per market address; `null` when it cannot be read. */
export type OpenTimeSource = (
  addresses: readonly string[],
) => Promise<Record<string, number | null>>;

const PAGE = 1_000;
const MAX_PAGES = 5;

type SignaturesApi = Pick<Connection, "getSignaturesForAddress">;

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

export function createOpenTimeSource(
  config: PublicConfig,
  connection: SignaturesApi = new Connection(config.rpcUrl, "confirmed"),
): OpenTimeSource {
  const cache = new Map<string, number | null>();
  return async (addresses) => {
    const out: Record<string, number | null> = {};
    await Promise.all(
      addresses.map(async (address) => {
        if (cache.has(address)) {
          out[address] = cache.get(address) ?? null;
          return;
        }
        let time: number | null = null;
        try {
          time = await creationBlockTime(connection, new PublicKey(address));
        } catch {
          out[address] = null; // not cached: a failed read is retried on the next poll
          return;
        }
        if (time !== null) cache.set(address, time);
        out[address] = time;
      }),
    );
    return out;
  };
}
