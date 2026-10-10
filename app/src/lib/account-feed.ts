/**
 * The app's one source of live account data (P1-2). Every reader that used to poll on its own
 * timer (the Trade book + vault, the wallet's balances, the Markets and Trade ladder books,
 * Portfolio's books) registers the accounts it needs here instead:
 *
 * - Push: each account is subscribed once on the shared pubsub socket, however many readers
 *   want it; a notification updates the cached bytes and wakes only the readers of that account.
 * - Poll fallback: while any watched account is not live (no socket, socket down, subscription
 *   not confirmed), ONE batched `getMultipleAccounts` for every watched account runs at the
 *   fastest interval its readers asked for. While everything is live it runs only as a slow
 *   heartbeat, so push and full-rate polling never run together.
 * - De-duplication: readers mounting together share one read; a read requested while another is
 *   in flight runs once after it. Replies older (by slot) than the cached bytes are dropped.
 * - A hidden tab skips timed reads and catches up once when it is shown again.
 */
import type { AccountSocket } from "./account-socket";
import { isDocumentVisible, onDocumentVisible } from "./visibility";

/** One batched read: account bytes in key order (`null` = missing) and the slot of the read. */
export type FetchedAccounts = {
  readonly slot: number;
  readonly values: readonly (Uint8Array | null)[];
};

export type FeedEntry = {
  readonly data: Uint8Array | null;
  readonly slot: number;
  /** Client ms when these bytes were last confirmed current (a read or a push). */
  readonly checkedAt: number;
};

export type AccountFeedOptions = {
  readonly fetchMany: (keys: readonly string[]) => Promise<FetchedAccounts>;
  /** `null` where the endpoint has no pubsub socket: the feed then only polls. */
  readonly socket: AccountSocket | null;
  /** Safety-net read interval while every watched account is live. */
  readonly heartbeatMs?: number;
  readonly now?: () => number;
  readonly isVisible?: () => boolean;
  readonly onVisible?: (listener: () => void) => () => void;
};

export type AccountFeed = {
  /**
   * Keeps `keys` fresh until the returned function is called. `fastMs` is this reader's poll
   * interval while push is unavailable; `listener` fires when any of its accounts, the read
   * error or liveness changes.
   */
  watch(keys: readonly string[], fastMs: number, listener: () => void): () => void;
  entry(key: string): FeedEntry | undefined;
  /** The last read's error, cleared by the next successful read. */
  error(): string | null;
  /** Every key is pushed by a confirmed subscription on an open socket. */
  isLive(keys: readonly string[]): boolean;
  /** Reads every watched account now (shared with an in-flight read). */
  refresh(): Promise<void>;
  dispose(): void;
};

type Watcher = {
  readonly keys: readonly string[];
  readonly fastMs: number;
  readonly listener: () => void;
};

export const HEARTBEAT_MS = 30_000;

export function createAccountFeed(options: AccountFeedOptions): AccountFeed {
  const {
    fetchMany,
    socket,
    heartbeatMs = HEARTBEAT_MS,
    now = Date.now,
    isVisible = isDocumentVisible,
    onVisible = onDocumentVisible,
  } = options;
  const watchers = new Set<Watcher>();
  const refs = new Map<string, number>();
  const entries = new Map<string, FeedEntry>();
  let lastError: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDue = 0;
  let soon: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let again = false;
  let wasAllLive = false;

  const isLive = (keys: readonly string[]): boolean =>
    keys.every((key) => socket !== null && socket.isLive(key));
  const allLive = (): boolean => refs.size > 0 && isLive([...refs.keys()]);

  const notify = (changed: ReadonlySet<string> | "all"): void => {
    for (const watcher of [...watchers]) {
      if (changed === "all" || watcher.keys.some((key) => changed.has(key))) watcher.listener();
    }
  };

  /** Stores the bytes unless they are older than what is cached. */
  const apply = (key: string, data: Uint8Array | null, slot: number): boolean => {
    const previous = entries.get(key);
    if (previous !== undefined && slot < previous.slot) return false;
    entries.set(key, { data, slot, checkedAt: now() });
    return true;
  };

  const runRead = async (keys: readonly string[]): Promise<void> => {
    try {
      const { slot, values } = await fetchMany(keys);
      const changed = new Set<string>();
      keys.forEach((key, index) => {
        if (refs.has(key) && apply(key, values[index] ?? null, slot)) changed.add(key);
      });
      lastError = null;
      notify(changed);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      notify("all");
    }
  };

  const poll = (): Promise<void> => {
    if (inFlight !== null) {
      again = true;
      return inFlight;
    }
    const keys = [...refs.keys()];
    if (keys.length === 0) return Promise.resolve();
    const current = runRead(keys).finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        void poll();
      }
    });
    inFlight = current;
    return current;
  };

  /** Coalesces the reads of readers mounting in the same tick into one. */
  const pollSoon = (): void => {
    if (soon !== null) return;
    soon = setTimeout(() => {
      soon = null;
      void poll();
    }, 0);
  };

  const interval = (): number | null => {
    if (watchers.size === 0) return null;
    let fastest = Number.POSITIVE_INFINITY;
    for (const watcher of watchers) {
      if (!isLive(watcher.keys)) fastest = Math.min(fastest, watcher.fastMs);
    }
    return Number.isFinite(fastest) ? fastest : heartbeatMs;
  };

  const tick = (): void => {
    timer = null;
    if (isVisible()) void poll();
    schedule();
  };

  /** Arms the poll timer; an armed timer that is due sooner is kept, so polls never starve. */
  function schedule(): void {
    const ms = interval();
    if (ms === null) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return;
    }
    if (timer !== null && timerDue <= now() + ms) return;
    if (timer !== null) clearTimeout(timer);
    timerDue = now() + ms;
    timer = setTimeout(tick, ms);
  }

  const onHealth = (): void => {
    const live = allLive();
    // Catch up once when push takes over: a change between the last read and the subscription
    // confirmations would otherwise be missed until the heartbeat.
    if (live && !wasAllLive) pollSoon();
    wasAllLive = live;
    schedule();
    notify("all");
  };
  const stopHealth = socket?.onHealthChange(onHealth) ?? (() => undefined);
  const stopVisible = onVisible(() => {
    if (!allLive()) void poll();
  });

  const subscribeKey = (key: string): void => {
    socket?.subscribe(key, (data, slot) => {
      if (refs.has(key) && apply(key, data, slot)) notify(new Set([key]));
    });
  };

  return {
    watch(keys, fastMs, listener) {
      if (keys.length === 0) return () => undefined;
      const watcher: Watcher = { keys: [...keys], fastMs, listener };
      watchers.add(watcher);
      let missing = false;
      for (const key of watcher.keys) {
        const count = refs.get(key) ?? 0;
        refs.set(key, count + 1);
        if (count === 0) subscribeKey(key);
        if (!entries.has(key)) missing = true;
      }
      wasAllLive = allLive();
      if (missing) pollSoon();
      schedule();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        watchers.delete(watcher);
        for (const key of watcher.keys) {
          const count = (refs.get(key) ?? 1) - 1;
          if (count > 0) {
            refs.set(key, count);
            continue;
          }
          refs.delete(key);
          entries.delete(key);
          socket?.unsubscribe(key);
        }
        wasAllLive = allLive();
        schedule();
      };
    },
    entry: (key) => entries.get(key),
    error: () => lastError,
    isLive,
    refresh: poll,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      if (soon !== null) clearTimeout(soon);
      timer = null;
      soon = null;
      for (const key of refs.keys()) socket?.unsubscribe(key);
      watchers.clear();
      refs.clear();
      entries.clear();
      stopHealth();
      stopVisible();
    },
  };
}

/** A value read once or repeatedly, the shape every live and polled reader exposes. */
export type LiveRead<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

/** A decoded view over feed accounts, consumed by `usePolled` and `useMarketData`. */
export type LiveSource<T> = {
  /** Starts keeping the accounts fresh; `onChange` fires when `read()` or `isLive()` may change. */
  subscribe(onChange: () => void): () => void;
  /** The same object until an account, the read error or the key set changes. */
  read(): LiveRead<T>;
  isLive(): boolean;
  refresh(): void;
};

/**
 * Decodes `keys` (or keys resolved once, e.g. a wallet's token accounts) from the feed. `decode`
 * gets the bytes in key order and the oldest `checkedAt`; a throw becomes an `error` read.
 */
export function liveSource<T>(
  feed: AccountFeed,
  keys: readonly string[] | (() => Promise<readonly string[]>),
  fastMs: number,
  decode: (data: readonly (Uint8Array | null)[], checkedAt: number) => T,
): LiveSource<T> {
  let resolved: readonly string[] | null = typeof keys === "function" ? null : keys;
  let resolveError: string | null = null;
  let cache:
    | {
        readonly entries: readonly (FeedEntry | undefined)[];
        readonly error: string | null;
        readonly result: LiveRead<T>;
      }
    | undefined;

  const compute = (list: readonly string[]): LiveRead<T> => {
    const current = list.map((key) => feed.entry(key));
    const error = feed.error();
    if (
      cache !== undefined &&
      cache.error === error &&
      cache.entries.length === current.length &&
      cache.entries.every((entry, index) => entry === current[index])
    ) {
      return cache.result;
    }
    let result: LiveRead<T>;
    const ready = current.filter((entry): entry is FeedEntry => entry !== undefined);
    if (ready.length < current.length) {
      result = error === null ? { status: "loading" } : { status: "error", message: error };
    } else {
      try {
        const checkedAt = ready.reduce(
          (oldest, entry) => Math.min(oldest, entry.checkedAt),
          Infinity,
        );
        result = {
          status: "ready",
          value: decode(
            ready.map((entry) => entry.data),
            Number.isFinite(checkedAt) ? checkedAt : Date.now(),
          ),
        };
      } catch (decodeError) {
        result = {
          status: "error",
          message: decodeError instanceof Error ? decodeError.message : String(decodeError),
        };
      }
    }
    cache = { entries: current, error, result };
    return result;
  };

  return {
    subscribe(onChange) {
      let cancelled = false;
      let stop: () => void = () => undefined;
      if (resolved !== null) {
        stop = feed.watch(resolved, fastMs, onChange);
      } else if (typeof keys === "function") {
        keys().then(
          (list) => {
            if (cancelled) return;
            resolved = list;
            stop = feed.watch(list, fastMs, onChange);
            onChange();
          },
          (error: unknown) => {
            if (cancelled) return;
            resolveError = error instanceof Error ? error.message : String(error);
            onChange();
          },
        );
      }
      return () => {
        cancelled = true;
        stop();
      };
    },
    read() {
      if (resolveError !== null) return { status: "error", message: resolveError };
      return resolved === null ? { status: "loading" } : compute(resolved);
    },
    isLive: () => resolved !== null && feed.isLive(resolved),
    refresh: () => void feed.refresh(),
  };
}
