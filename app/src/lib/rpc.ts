/**
 * One shared, rate-limit-aware `Connection` per RPC URL. The public devnet endpoint answers bursts
 * with HTTP 429, so every reader shares this connection and retries 429/503 with exponential
 * backoff plus full jitter (honouring `Retry-After`) instead of web3.js's fixed retry schedule.
 */
import { Connection } from "@solana/web3.js";

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
