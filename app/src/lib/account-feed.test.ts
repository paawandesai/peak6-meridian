import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AccountFeed, createAccountFeed, HEARTBEAT_MS, liveSource } from "./account-feed";
import { type AccountSocket, createAccountSocket } from "./account-socket";
import { fakeFetcher, fakeServer } from "./account-test-support";

const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(options: { socket?: boolean; accounts?: Record<string, number[] | null> } = {}) {
  const fetcher = fakeFetcher(options.accounts ?? { A: [1], B: [2], C: [3] });
  const server = fakeServer();
  const socket: AccountSocket | null =
    options.socket === true ? createAccountSocket("wss://x/", { connect: server.connect }) : null;
  const visibility = { visible: true, listener: null as (() => void) | null };
  const feed = createAccountFeed({
    fetchMany: fetcher.fetchMany,
    socket,
    isVisible: () => visibility.visible,
    onVisible: (listener) => {
      visibility.listener = listener;
      return () => {
        visibility.listener = null;
      };
    },
  });
  return { feed, fetcher, server, socket, visibility };
}

let feeds: AccountFeed[] = [];
const track = <T extends { feed: AccountFeed; socket: AccountSocket | null }>(made: T): T => {
  feeds.push(made.feed);
  return made;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const feed of feeds) feed.dispose();
  feeds = [];
  vi.useRealTimers();
});

describe("createAccountFeed: poll fallback (no socket)", () => {
  it("shares one batched read between readers mounting together", async () => {
    const { feed, fetcher } = track(setup());
    feed.watch(["A", "B"], 1_000, () => undefined);
    feed.watch(["B", "C"], 2_000, () => undefined);
    await flush();
    expect(fetcher.state.calls).toEqual([["A", "B", "C"]]);
    expect(feed.entry("B")?.data).toEqual(new Uint8Array([2]));
  });

  it("polls every watched account at the fastest reader's interval, one request per tick", async () => {
    const { feed, fetcher } = track(setup());
    feed.watch(["A"], 1_000, () => undefined);
    feed.watch(["B", "C"], 2_000, () => undefined);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.state.calls).toHaveLength(61); // t = 0 … 60 s
    expect(fetcher.state.calls.every((keys) => keys.length === 3)).toBe(true);
  });

  it("shows a change within 1 s at a 1 s fallback interval", async () => {
    const { feed, fetcher } = track(setup());
    const listener = vi.fn();
    feed.watch(["A"], 1_000, listener);
    await flush();
    fetcher.state.accounts.A = [42];
    fetcher.state.slot = 11;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.entry("A")?.data).toEqual(new Uint8Array([42]));
    expect(listener).toHaveBeenCalled();
  });

  it("is not live without a socket, except for an empty key list", () => {
    const { feed } = track(setup());
    expect(feed.isLive(["A"])).toBe(false);
    expect(feed.isLive([])).toBe(true);
  });

  it("keeps the cached bytes on a failed read, reports the error to every reader, clears it on success", async () => {
    const { feed, fetcher } = track(setup());
    const listener = vi.fn();
    feed.watch(["A"], 1_000, listener);
    await flush();
    fetcher.state.fail = "429 Too Many Requests";
    listener.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.error()).toBe("429 Too Many Requests");
    expect(feed.entry("A")?.data).toEqual(new Uint8Array([1]));
    expect(listener).toHaveBeenCalled();
    fetcher.state.fail = null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(feed.error()).toBeNull();
  });

  it("skips timed reads while hidden and catches up once when shown", async () => {
    const { feed, fetcher, visibility } = track(setup());
    feed.watch(["A"], 1_000, () => undefined);
    await flush();
    visibility.visible = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher.state.calls).toHaveLength(1);
    visibility.visible = true;
    visibility.listener?.();
    await flush();
    expect(fetcher.state.calls).toHaveLength(2);
  });

  it("runs exactly one more read when refreshed during an in-flight read", async () => {
    const { fetcher } = track(setup());
    let release: () => void = () => undefined;
    const slow = fetcher.fetchMany;
    const fetchMany = vi.fn(
      (keys: readonly string[]) =>
        new Promise<Awaited<ReturnType<typeof slow>>>((resolve) => {
          release = () => void slow(keys).then(resolve);
        }),
    );
    const gated = createAccountFeed({
      fetchMany,
      socket: null,
      isVisible: () => true,
      onVisible: () => () => undefined,
    });
    feeds.push(gated);
    gated.watch(["A"], 60_000, () => undefined);
    await flush();
    expect(fetchMany).toHaveBeenCalledTimes(1);
    void gated.refresh();
    void gated.refresh();
    expect(fetchMany).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(fetchMany).toHaveBeenCalledTimes(2);
    release();
    await flush();
    expect(fetchMany).toHaveBeenCalledTimes(2);
  });

  it("stops polling and drops the bytes when the last reader leaves", async () => {
    const { feed, fetcher } = track(setup());
    const stopA = feed.watch(["A", "B"], 1_000, () => undefined);
    const stopB = feed.watch(["B"], 1_000, () => undefined);
    await flush();
    stopA();
    stopA(); // idempotent
    expect(feed.entry("A")).toBeUndefined();
    expect(feed.entry("B")).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher.state.calls.at(-1)).toEqual(["B"]);
    stopB();
    const calls = fetcher.state.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher.state.calls).toHaveLength(calls);
  });

  it("ignores an empty key list", async () => {
    const { feed, fetcher } = track(setup());
    const stop = feed.watch([], 1_000, () => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher.state.calls).toHaveLength(0);
    stop();
  });

  it("a reply for a key unwatched mid-read is not stored", async () => {
    const { feed } = track(setup());
    const stop = feed.watch(["A"], 1_000, () => undefined);
    stop();
    void feed.refresh();
    await flush();
    expect(feed.entry("A")).toBeUndefined();
  });
});

describe("createAccountFeed: push (socket)", () => {
  async function liveFeed() {
    const made = track(setup({ socket: true }));
    const listenerAB = vi.fn();
    const listenerC = vi.fn();
    made.feed.watch(["A", "B"], 1_000, listenerAB);
    made.feed.watch(["C"], 2_000, listenerC);
    await flush(); // initial read
    made.server.last().handlers.onOpen();
    made.server.confirmAll();
    await flush(); // catch-up read once push took over
    return { ...made, listenerAB, listenerC };
  }

  it("subscribes each watched account once on the shared socket", async () => {
    const { server, feed } = await liveFeed();
    feed.watch(["A"], 1_000, () => undefined); // a second reader of A
    expect(server.subscribes().map((m) => (m.params as unknown[])[0])).toEqual(["A", "B", "C"]);
    expect(feed.isLive(["A", "B", "C"])).toBe(true);
  });

  it("drops to the heartbeat while everything is live: no full-rate polling alongside push", async () => {
    const { fetcher } = await liveFeed();
    expect(fetcher.state.calls).toHaveLength(2); // initial + catch-up
    await vi.advanceTimersByTimeAsync(60_000);
    // The 1 s timer armed before push took over fires once, then only heartbeats.
    expect(fetcher.state.calls.length).toBeLessThanOrEqual(
      2 + 1 + Math.ceil(60_000 / HEARTBEAT_MS),
    );
  });

  it("applies a pushed change at once and wakes only that account's readers", async () => {
    const { feed, server, listenerAB, listenerC } = await liveFeed();
    listenerAB.mockClear();
    listenerC.mockClear();
    server.push("C", 50, [7, 7]);
    expect(feed.entry("C")?.data).toEqual(new Uint8Array([7, 7]));
    expect(listenerC).toHaveBeenCalledTimes(1);
    expect(listenerAB).not.toHaveBeenCalled();
    server.push("A", 51, null); // closed account
    expect(feed.entry("A")?.data).toBeNull();
  });

  it("drops a read older (by slot) than pushed bytes", async () => {
    const { feed, server, fetcher } = await liveFeed();
    server.push("A", 50, [9]);
    fetcher.state.slot = 40; // a slower read from before the push
    await feed.refresh();
    expect(feed.entry("A")?.data).toEqual(new Uint8Array([9]));
    expect(feed.entry("B")?.slot).toBe(40); // B had nothing newer than slot 40: taken
  });

  it("falls back to full-rate polling the moment the socket drops, and catches up on reconnect", async () => {
    const { feed, server, fetcher } = await liveFeed();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    const before = fetcher.state.calls.length;
    server.last().handlers.onClose();
    expect(feed.isLive(["A"])).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher.state.calls.length).toBe(before + 1); // the 1 s fallback is back
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher.state.calls.length).toBe(before + 6);
    // The socket reconnects (backoff ≤ 1 s for the first retry) and resubscribes.
    const reconnected = server.last();
    reconnected.handlers.onOpen();
    server.confirmAll(reconnected);
    const atConfirm = fetcher.state.calls.length;
    await flush();
    expect(fetcher.state.calls.length).toBe(atConfirm + 1); // one catch-up read
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 2_000);
    expect(fetcher.state.calls.length).toBeLessThanOrEqual(atConfirm + 2);
  });

  it("unsubscribes an account when its last reader leaves, and on dispose", async () => {
    const { feed, server } = await liveFeed();
    const stop = feed.watch(["D"], 1_000, () => undefined);
    server.confirmAll();
    stop();
    expect(server.last().sent.at(-1)).toMatchObject({ method: "accountUnsubscribe" });
    feed.dispose();
    const unsubscribes = server.last().sent.filter((m) => m.method === "accountUnsubscribe");
    expect(unsubscribes.length).toBeGreaterThanOrEqual(4); // D, then A, B and C
  });

  it("does not catch up when the visible tab is already fully live", async () => {
    const { fetcher, visibility } = await liveFeed();
    const calls = fetcher.state.calls.length;
    visibility.listener?.();
    await flush();
    expect(fetcher.state.calls.length).toBe(calls);
  });
});

describe("liveSource", () => {
  const sum = (data: readonly (Uint8Array | null)[]) =>
    data.reduce((total, bytes) => total + (bytes?.[0] ?? 0), 0);

  it("is loading until every account is read, then decodes them in key order", async () => {
    const { feed } = track(setup());
    const source = liveSource(feed, ["A", "B"], 1_000, (data) => data.map((d) => d?.[0] ?? null));
    expect(source.read()).toEqual({ status: "loading" });
    const onChange = vi.fn();
    const stop = source.subscribe(onChange);
    await flush();
    expect(onChange).toHaveBeenCalled();
    expect(source.read()).toEqual({ status: "ready", value: [1, 2] });
    stop();
  });

  it("returns the same object until an account changes", async () => {
    const { feed, fetcher } = track(setup());
    const source = liveSource(feed, ["A"], 1_000, sum);
    source.subscribe(() => undefined);
    await flush();
    const first = source.read();
    expect(source.read()).toBe(first);
    fetcher.state.accounts.A = [5];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(source.read()).not.toBe(first);
    expect(source.read()).toEqual({ status: "ready", value: 5 });
  });

  it("passes the oldest confirmation time to decode", async () => {
    const { feed } = track(setup());
    vi.setSystemTime(1_791_486_000_000);
    const source = liveSource(feed, ["A", "B"], 1_000, (_data, checkedAt) => checkedAt);
    source.subscribe(() => undefined);
    await flush();
    expect(source.read()).toEqual({ status: "ready", value: 1_791_486_000_000 });
  });

  it("turns a decode failure into an error read", async () => {
    const { feed } = track(setup());
    const source = liveSource(feed, ["A"], 1_000, () => {
      throw new Error("book account not found");
    });
    source.subscribe(() => undefined);
    await flush();
    expect(source.read()).toEqual({ status: "error", message: "book account not found" });
  });

  it("reports a read error while nothing has been read yet", async () => {
    const { feed, fetcher } = track(setup());
    fetcher.state.fail = "rpc down";
    const source = liveSource(feed, ["A"], 1_000, sum);
    source.subscribe(() => undefined);
    await flush();
    expect(source.read()).toEqual({ status: "error", message: "rpc down" });
  });

  it("resolves its keys once (a wallet's token accounts) before watching", async () => {
    const { feed, fetcher } = track(setup());
    const resolve = vi.fn(() => Promise.resolve(["B", "C"]));
    const source = liveSource(feed, resolve, 1_000, sum);
    expect(source.isLive()).toBe(false);
    const onChange = vi.fn();
    const stop = source.subscribe(onChange);
    expect(source.read()).toEqual({ status: "loading" });
    await flush();
    expect(source.read()).toEqual({ status: "ready", value: 5 });
    expect(fetcher.state.calls[0]).toEqual(["B", "C"]);
    stop();
    source.subscribe(() => undefined);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("reports a key-resolution failure, and ignores one after unsubscribe", async () => {
    const { feed } = track(setup());
    const failing = liveSource(feed, () => Promise.reject(new Error("no config")), 1_000, sum);
    failing.subscribe(() => undefined);
    await flush();
    expect(failing.read()).toEqual({ status: "error", message: "no config" });
    const late = liveSource(feed, () => Promise.reject(new Error("late")), 1_000, sum);
    late.subscribe(() => undefined)();
    await flush();
    expect(late.read()).toEqual({ status: "loading" });
  });

  it("is live when the feed pushes all its accounts, and refresh reads now", async () => {
    const { feed, server, fetcher } = track(setup({ socket: true }));
    const source = liveSource(feed, ["A"], 1_000, sum);
    source.subscribe(() => undefined);
    await flush();
    server.last().handlers.onOpen();
    server.confirmAll();
    expect(source.isLive()).toBe(true);
    await flush();
    const calls = fetcher.state.calls.length;
    source.refresh();
    await flush();
    expect(fetcher.state.calls.length).toBe(calls + 1);
  });
});

describe("createAccountFeed: invariants", () => {
  it("never stores bytes from an older slot than the cached ones", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 255 })), {
          minLength: 1,
          maxLength: 20,
        }),
        async (pushes) => {
          const { feed, server } = setup({ socket: true });
          feed.watch(["A"], 1_000, () => undefined);
          await flush();
          server.last().handlers.onOpen();
          server.confirmAll();
          let best = { slot: 10, byte: 1 }; // the initial read is slot 10, byte 1
          for (const [slot, byte] of pushes) {
            server.push("A", slot, [byte]);
            if (slot >= best.slot) best = { slot, byte };
          }
          const entry = feed.entry("A");
          feed.dispose();
          return entry?.slot === best.slot && entry.data?.[0] === best.byte;
        },
      ),
      { numRuns: 50 },
    );
  });
});
