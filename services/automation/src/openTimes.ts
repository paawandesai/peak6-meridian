/**
 * Market open-time index (P1-4; D-050, OQ-14): when each market was created, served on
 * `GET /markets` so the app shows every market's real open time without scanning signatures per
 * market.
 *
 * "Open" is creation (the program has no open gate): the block time of the transaction that
 * emitted the market's `MarketCreated` event. Every `create_strike_market` is signed by
 * `config.automation_authority` (AB-19), so one paged `getSignaturesForAddress` over that single
 * address, plus batched `getTransactions` for the signatures it lists, finds every creation in
 * the lookback window, including markets created by the CLI or before a restart.
 *
 * Durable without a volume: the index is rebuilt from the chain at startup (one backfill scan),
 * then kept current with incremental scans (`until` the newest signature already seen) that run
 * at most once per `minRefreshMs`, when `/markets` is asked. The morning job also hands over each
 * creation signature as it lands (`noteCreated`), so a fresh market appears on the next refresh.
 * A market with no record is simply absent: the app shows "—", never a guessed time.
 */
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import { MERIDIAN_IDL } from "@meridian/client";
import { type Connection, PublicKey } from "@solana/web3.js";

import { describeError, type Logger } from "./log";

export interface SignatureEntry {
  readonly signature: string;
  readonly blockTime?: number | null;
  /** `null` for a transaction that succeeded. */
  readonly err: unknown;
}

export interface IndexedTx {
  readonly blockTime?: number | null;
  readonly meta: { readonly logMessages?: readonly string[] | null } | null;
}

/** The two RPC reads the index needs; `connectionOpenTimeRpc` adapts a web3.js `Connection`. */
export interface OpenTimeRpc {
  /** Newest first, at most `limit`, strictly older than `before`, stopping at `until`. */
  signatures(
    address: PublicKey,
    options: { readonly limit: number; readonly before?: string; readonly until?: string },
  ): Promise<readonly SignatureEntry[]>;
  /** One entry per signature, in order; `null` for a transaction the node cannot return yet. */
  transactions(signatures: readonly string[]): Promise<readonly (IndexedTx | null)[]>;
}

export function connectionOpenTimeRpc(
  connection: Pick<Connection, "getSignaturesForAddress" | "getTransactions">,
): OpenTimeRpc {
  return {
    signatures: (address, options) =>
      connection.getSignaturesForAddress(address, { ...options }, "confirmed"),
    transactions: (signatures) =>
      connection.getTransactions([...signatures], {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      }),
  };
}

export interface OpenTimeOptions {
  /** Markets created longer ago than this are neither scanned for nor kept. */
  readonly lookbackSecs: number;
  readonly pageSize: number;
  /** Signature pages read per scan at most (a backfill beyond this stops early and says so). */
  readonly maxPages: number;
  /** Transactions per `getTransactions` request. */
  readonly txBatch: number;
  /** Pause between transaction batches, to stay inside public RPC rate limits. */
  readonly batchPauseMs: number;
  /** `/markets` refreshes the index at most this often. */
  readonly minRefreshMs: number;
  /** First wait between failed startup backfill attempts; doubles up to `backfillRetryMaxMs`. */
  readonly backfillRetryMs: number;
  readonly backfillRetryMaxMs: number;
}

export const OPEN_TIME_OPTIONS: OpenTimeOptions = {
  // A week covers a long weekend plus a holiday, so Friday's markets keep their open time on Tuesday.
  lookbackSecs: 7 * 86_400,
  pageSize: 1_000,
  maxPages: 20,
  // Paced for the shared public devnet RPC (about 100 requests per 10 s per IP, and each
  // transaction in a batch counts): 5 every 2 s leaves headroom for the settlement job.
  txBatch: 5,
  batchPauseMs: 2_000,
  minRefreshMs: 30_000,
  backfillRetryMs: 15_000,
  backfillRetryMaxMs: 300_000,
};

export interface OpenTimeEntry {
  /** Base58 market address. */
  readonly market: string;
  /** Block time of the creation transaction, unix seconds. */
  readonly openedAt: number;
  readonly signature: string;
}

export interface OpenTimeSnapshot {
  /**
   * False until the first backfill has been fully resolved: an absent market then means "not
   * known yet" rather than "no record". Markets already resolved are listed either way.
   */
  readonly ready: boolean;
  /** When the index last refreshed successfully (ISO 8601), or null. */
  readonly asOf: string | null;
  readonly markets: readonly OpenTimeEntry[];
}

export interface OpenTimeIndexDeps {
  readonly rpc: OpenTimeRpc;
  readonly programId: PublicKey;
  /** `config.automation_authority`, the signer of every `create_strike_market`. */
  readonly readAuthority: () => Promise<PublicKey>;
  readonly now: () => Date;
  readonly log: Logger;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly options?: Partial<OpenTimeOptions>;
}

export interface OpenTimeIndex {
  /** Runs one refresh (backfill first, incremental after); concurrent calls share one run. */
  refresh(): Promise<void>;
  /** Refreshes when the last attempt is older than `minRefreshMs`; otherwise returns at once. */
  refreshIfStale(): Promise<void>;
  /**
   * Refreshes until the first backfill is complete, waiting `backfillRetryMs` between failed
   * attempts (doubling, capped, while an attempt resolves nothing), so a rate-limited RPC at
   * startup does not leave the index empty until someone asks. Never rejects.
   */
  backfill(): Promise<void>;
  /** Ends a running `backfill` loop (service shutdown). */
  stop(): void;
  /** Queues a creation signature from the morning job; it is resolved on the next refresh. */
  noteCreated(signature: string): void;
  snapshot(): OpenTimeSnapshot;
}

const DATA_PREFIX = "Program data: ";
/** A pending signature is retried on this many refreshes before it is given up. */
export const MAX_PENDING_ATTEMPTS = 10;

/**
 * The markets whose `MarketCreated` event appears in `logs`. Undecodable `Program data:` lines
 * are dropped first (one bad line inside `parseLogs` would end decoding for the whole
 * transaction), and a short body that decodes into zero-filled garbage is refused by requiring
 * it to re-encode to exactly the logged length.
 */
export function createdMarkets(logs: readonly string[], programId: PublicKey): string[] {
  const coder = new BorshCoder(MERIDIAN_IDL);
  const decodable = logs.filter((line) => {
    if (!line.startsWith(DATA_PREFIX)) return true;
    const encoded = line.slice(DATA_PREFIX.length);
    try {
      const decoded = coder.events.decode(encoded);
      if (decoded === null) return true;
      const length = Buffer.from(encoded, "base64").length - 8;
      return coder.types.encode(decoded.name, decoded.data).length === length;
    } catch {
      return false;
    }
  });
  const out: string[] = [];
  try {
    for (const event of new EventParser(programId, coder).parseLogs([...decodable])) {
      const market: unknown = (event.data as Record<string, unknown>).market;
      if (event.name === "MarketCreated" && market instanceof PublicKey) {
        out.push(market.toBase58());
      }
    }
  } catch {
    // An unparsable log stream yields whatever was decoded before it.
  }
  return out;
}

interface ScanResult {
  readonly found: readonly SignatureEntry[];
  /** The newest signature the scan saw (the next incremental scan stops there). */
  readonly newest: string | undefined;
  readonly truncated: boolean;
}

export function createOpenTimeIndex(deps: OpenTimeIndexDeps): OpenTimeIndex {
  const opts: OpenTimeOptions = { ...OPEN_TIME_OPTIONS, ...deps.options };
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const entries = new Map<string, OpenTimeEntry>();
  /**
   * Signatures still to resolve, newest first, with the attempts that came back empty: found by
   * a scan, noted by the morning job, or not returned by the node yet. Kept across failed
   * refreshes, so a rate-limited backfill resumes where it stopped instead of starting over. One
   * that never resolves (a dropped transaction) is given up after `MAX_PENDING_ATTEMPTS`.
   */
  const pending = new Map<string, number>();
  let authority: PublicKey | null = null;
  let cursor: string | undefined;
  let scanned = false;
  let ready = false;
  let asOf: string | null = null;
  let lastAttempt: number | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  /** Signatures resolved so far: a backfill attempt that moved it made progress. */
  let resolvedCount = 0;

  const scan = async (address: PublicKey, until: string | undefined, cutoff: number) => {
    const found: SignatureEntry[] = [];
    let before: string | undefined;
    let newest: string | undefined;
    for (let page = 0; page < opts.maxPages; page += 1) {
      const batch = await deps.rpc.signatures(address, {
        limit: opts.pageSize,
        ...(before === undefined ? {} : { before }),
        ...(until === undefined ? {} : { until }),
      });
      newest ??= batch[0]?.signature;
      for (const entry of batch) {
        if (typeof entry.blockTime === "number" && entry.blockTime < cutoff) {
          return { found, newest, truncated: false } satisfies ScanResult;
        }
        if (entry.err === null || entry.err === undefined) found.push(entry);
      }
      const last = batch[batch.length - 1];
      if (last === undefined || batch.length < opts.pageSize) {
        return { found, newest, truncated: false } satisfies ScanResult;
      }
      before = last.signature;
    }
    return { found, newest, truncated: true } satisfies ScanResult;
  };

  const record = (signature: string, tx: IndexedTx | null | undefined): boolean => {
    if (tx === null || tx === undefined) return false;
    const blockTime = tx.blockTime;
    const logs = tx.meta?.logMessages;
    if (logs === null || logs === undefined) return true;
    const markets = createdMarkets(logs, deps.programId);
    // A creation without a block time yet: try again rather than record no time.
    if (markets.length > 0 && typeof blockTime !== "number") return false;
    for (const market of markets) {
      // A market is created once; should two events ever name it, the earliest one wins.
      const known = entries.get(market);
      if (typeof blockTime === "number" && (known === undefined || blockTime < known.openedAt)) {
        entries.set(market, { market, openedAt: blockTime, signature });
      }
    }
    return true;
  };

  /** Resolves the pending signatures batch by batch; a failed batch stops and keeps the rest. */
  const drain = async (): Promise<void> => {
    const queue = [...pending.keys()];
    for (let at = 0; at < queue.length; at += opts.txBatch) {
      if (at > 0) await sleep(opts.batchPauseMs);
      const chunk = queue.slice(at, at + opts.txBatch);
      const txs = await deps.rpc.transactions(chunk);
      chunk.forEach((signature, index) => {
        if (record(signature, txs[index])) {
          pending.delete(signature);
          resolvedCount += 1;
          return;
        }
        const attempts = (pending.get(signature) ?? 0) + 1;
        if (attempts >= MAX_PENDING_ATTEMPTS) pending.delete(signature);
        else pending.set(signature, attempts);
      });
    }
  };

  const run = async (): Promise<void> => {
    const startedMs = deps.now().getTime();
    lastAttempt = startedMs;
    const cutoff = Math.floor(startedMs / 1_000) - opts.lookbackSecs;
    const before = entries.size;
    try {
      authority ??= await deps.readAuthority();
      const backfill = cursor === undefined;
      const result = await scan(authority, cursor, cutoff);
      if (result.truncated) {
        deps.log("warn", "open_times_scan_truncated", { backfill, pages: opts.maxPages });
      }
      for (const entry of result.found) {
        if (!pending.has(entry.signature)) pending.set(entry.signature, 0);
      }
      if (result.newest !== undefined) cursor = result.newest;
      scanned = true;
      await drain();
      for (const [market, entry] of entries) {
        if (entry.openedAt < cutoff) entries.delete(market);
      }
      // Ready once the first backfill has been fully resolved; it stays ready after that.
      ready = true;
      asOf = new Date(startedMs).toISOString();
      deps.log("info", "open_times_refreshed", {
        backfill,
        scanned: result.found.length,
        added: Math.max(0, entries.size - before),
        total: entries.size,
        pending: pending.size,
      });
    } catch (error) {
      deps.log("warn", "open_times_refresh_failed", {
        error: describeError(error),
        scanned,
        indexed: entries.size,
        pending: pending.size,
      });
    }
  };

  const refresh = (): Promise<void> => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    refresh,
    refreshIfStale: () => {
      if (inFlight !== null) return inFlight;
      if (lastAttempt !== null && deps.now().getTime() - lastAttempt < opts.minRefreshMs) {
        return Promise.resolve();
      }
      return refresh();
    },
    backfill: async () => {
      let delay = opts.backfillRetryMs;
      for (;;) {
        const before = resolvedCount;
        await refresh();
        if (ready || stopped) return;
        // A rate-limited attempt that still resolved some signatures waits the short delay again;
        // only attempts that made no progress back off further.
        delay = resolvedCount > before ? opts.backfillRetryMs : delay;
        await sleep(delay);
        if (stopped) return;
        delay = Math.min(delay * 2, opts.backfillRetryMaxMs);
      }
    },
    stop: () => {
      stopped = true;
    },
    noteCreated: (signature) => {
      if (!pending.has(signature)) pending.set(signature, 0);
      // The next `/markets` refresh resolves it straight away instead of waiting out the throttle.
      lastAttempt = null;
    },
    snapshot: () => ({
      ready,
      asOf,
      markets: [...entries.values()].sort((a, b) => a.market.localeCompare(b.market)),
    }),
  };
}

/** The JSON body of `GET /markets` (snake_case, like the other service contracts). */
export interface MarketsBody {
  readonly ready: boolean;
  readonly as_of: string | null;
  readonly markets: readonly {
    readonly market: string;
    readonly opened_at: number;
    readonly signature: string;
  }[];
}

export function marketsBody(snapshot: OpenTimeSnapshot): MarketsBody {
  return {
    ready: snapshot.ready,
    as_of: snapshot.asOf,
    markets: snapshot.markets.map((entry) => ({
      market: entry.market,
      opened_at: entry.openedAt,
      signature: entry.signature,
    })),
  };
}

/**
 * The `/markets` handler: refreshes when stale, but answers within `waitMs` with whatever the
 * index holds, so a slow RPC never holds the app's request past its own deadline.
 */
export async function marketsResponse(index: OpenTimeIndex, waitMs: number): Promise<MarketsBody> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([index.refreshIfStale(), deadline]);
  } finally {
    clearTimeout(timer);
  }
  return marketsBody(index.snapshot());
}
