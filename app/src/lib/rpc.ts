/**
 * One shared, rate-limit-aware `Connection` per RPC URL. The public devnet endpoint answers bursts
 * with HTTP 429, so every reader shares this connection and retries 429/503 with exponential
 * backoff plus full jitter (honouring `Retry-After`) instead of web3.js's fixed retry schedule.
 */
import { Connection, PublicKey } from "@solana/web3.js";

import { type AccountFeed, createAccountFeed, type FetchedAccounts } from "./account-feed";
import { type AccountSocket, browserConnect, createAccountSocket } from "./account-socket";

export type RetryOptions = {
  readonly retries?: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

const RETRYABLE = new Set([429, 503]);

/** Delay before retry `attempt` (0-based): full jitter over min(maxMs, baseMs * 2^attempt). */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random: () => number) {
  return Math.round(random() * Math.min(maxMs, baseMs * 2 ** attempt));
}

/** Wraps `fetch` so 429/503 responses are retried with backoff and jitter. */
export function withRateLimitRetry(
  inner: typeof fetch,
  {
    retries = 5,
    baseMs = 400,
    maxMs = 8_000,
    random = Math.random,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: RetryOptions = {},
): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await inner(input, init);
      if (!RETRYABLE.has(response.status) || attempt >= retries) return response;
      const retryAfter = Number(response.headers.get("retry-after"));
      const jittered = backoffMs(attempt, baseMs, maxMs, random);
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(maxMs, retryAfter * 1_000) + jittered
          : jittered,
      );
    }
  };
}

const connections = new Map<string, Connection>();

/** The app-wide connection for `rpcUrl` (created once, reused by every reader). */
export function sharedConnection(rpcUrl: string): Connection {
  let connection = connections.get(rpcUrl);
  if (connection === undefined) {
    connection = new Connection(rpcUrl, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: withRateLimitRetry((input, init) => fetch(input, init)),
    });
    connections.set(rpcUrl, connection);
  }
  return connection;
}

/**
 * Shares one in-flight call between concurrent callers and reuses a success for `ttlMs`, so the
 * header, page and widgets mounting together on navigation cost one RPC round-trip. Failures are
 * not cached.
 */
export function dedupe<T>(load: () => Promise<T>, ttlMs: number, now = Date.now): () => Promise<T> {
  let entry: { promise: Promise<T>; at: number } | undefined;
  return () => {
    if (entry !== undefined && now() - entry.at < ttlMs) return entry.promise;
    const promise = load();
    const current = { promise, at: now() };
    entry = current;
    promise.catch(() => {
      if (entry === current) entry = undefined;
    });
    return promise;
  };
}

/**
 * `getMultipleParsedAccounts` wrapper that chunks keys into batches of at most 99 to stay under
 * the Solana RPC 100-key limit. Useful for /status and any multi-key read. Results are returned
 * in the same order as `keys`. Each chunk is fetched serially to avoid bursts.
 */
export async function getMultipleChunked<T>(
  connection: {
    getMultipleParsedAccounts(keys: PublicKey[], opts?: unknown): Promise<{ value: T[] }>;
  },
  keys: PublicKey[],
  opts?: unknown,
): Promise<T[]> {
  const CHUNK_SIZE = 99;
  const results: T[] = [];
  for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
    const chunk = keys.slice(i, i + CHUNK_SIZE);
    const { value } = await connection.getMultipleParsedAccounts(chunk, opts);
    results.push(...value);
  }
  return results;
}

/**
 * The pubsub endpoint of an HTTP RPC URL, derived the way web3.js does: http→ws, https→wss, an
 * explicit port + 1 (local validator 8899 → 8900); path and query are kept (provider API keys
 * live in the query). `null` for anything that is not an absolute http(s) URL, such as a
 * same-origin proxy path, which cannot carry a socket.
 */
export function wsUrlFor(rpcUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.port !== "") url.port = String(Number(url.port) + 1);
  return url.toString();
}

/** Batched account reads for the feed: ≤99 keys per call, the oldest slot of the chunks. */
export function connectionFetcher(
  connection: Pick<Connection, "getMultipleAccountsInfoAndContext">,
): (keys: readonly string[]) => Promise<FetchedAccounts> {
  return async (keys) => {
    const CHUNK_SIZE = 99;
    const values: (Uint8Array | null)[] = [];
    let slot = Number.POSITIVE_INFINITY;
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      const chunk = keys.slice(i, i + CHUNK_SIZE).map((key) => new PublicKey(key));
      const { context, value } = await connection.getMultipleAccountsInfoAndContext(
        chunk,
        "confirmed",
      );
      slot = Math.min(slot, context.slot);
      for (const info of value) values.push(info === null ? null : info.data);
    }
    return { slot: Number.isFinite(slot) ? slot : 0, values };
  };
}

/** A pubsub socket for `rpcUrl` in a browser, `null` on the server or without a ws endpoint. */
export function browserAccountSocket(rpcUrl: string): AccountSocket | null {
  if (typeof window === "undefined" || typeof WebSocket !== "function") return null;
  const wsUrl = wsUrlFor(rpcUrl);
  return wsUrl === null ? null : createAccountSocket(wsUrl, { connect: browserConnect });
}

const feeds = new Map<string, AccountFeed>();

/** The app-wide account feed for `rpcUrl` (P1-2): one socket and one poll loop per endpoint. */
export function sharedAccountFeed(rpcUrl: string): AccountFeed {
  let feed = feeds.get(rpcUrl);
  if (feed === undefined) {
    feed = createAccountFeed({
      fetchMany: connectionFetcher(sharedConnection(rpcUrl)),
      socket: browserAccountSocket(rpcUrl),
    });
    feeds.set(rpcUrl, feed);
  }
  return feed;
}
