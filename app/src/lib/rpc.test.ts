import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  backoffMs,
  browserAccountSocket,
  connectionFetcher,
  dedupe,
  getMultipleChunked,
  sharedAccountFeed,
  sharedConnection,
  withRateLimitRetry,
  wsUrlFor,
} from "./rpc";

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response("{}", { status, headers });

describe("withRateLimitRetry", () => {
  it("retries 429 with jittered backoff, then returns the success", async () => {
    const inner = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));
    const sleeps: number[] = [];
    const wrapped = withRateLimitRetry(inner, {
      baseMs: 100,
      random: () => 0.5,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect((await wrapped("http://rpc", {})).status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([50, 100]);
  });

  it("gives up after the retry budget and honours Retry-After", async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(res(429, { "retry-after": "1" }));
    const sleeps: number[] = [];
    const wrapped = withRateLimitRetry(inner, {
      retries: 2,
      random: () => 0,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect((await wrapped("http://rpc", {})).status).toBe(429);
    expect(inner).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("does not retry other errors", async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(res(500));
    expect((await withRateLimitRetry(inner)("http://rpc", {})).status).toBe(500);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe("backoffMs", () => {
  it("caps the exponential window", () => {
    expect(backoffMs(10, 400, 8000, () => 1)).toBe(8000);
  });
});

describe("dedupe", () => {
  it("shares in-flight calls and caches within the TTL, but not failures", async () => {
    let t = 0;
    const load = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue(1);
    const get = dedupe(load, 1000, () => t);
    await expect(get()).rejects.toThrow("429");
    const [a, b] = await Promise.all([get(), get()]);
    expect([a, b]).toEqual([1, 1]);
    expect(load).toHaveBeenCalledTimes(2);
    t = 2000;
    await get();
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe("sharedConnection", () => {
  it("returns one connection per URL", () => {
    expect(sharedConnection("http://a.test")).toBe(sharedConnection("http://a.test"));
    expect(sharedConnection("http://a.test")).not.toBe(sharedConnection("http://b.test"));
  });
});

describe("getMultipleChunked", () => {
  it("chunks keys into batches of 99 to stay under the 100-key limit", async () => {
    const keys = Array.from({ length: 250 }, (_, i) => new PublicKey(i + 1));
    const calls: number[] = [];
    const connection = {
      getMultipleParsedAccounts: vi.fn(async (chunk: PublicKey[]) => {
        calls.push(chunk.length);
        return { value: chunk.map(() => null) };
      }),
    };
    const result = await getMultipleChunked(connection, keys, { commitment: "confirmed" });
    expect(result).toHaveLength(250);
    expect(calls).toEqual([99, 99, 52]); // 3 chunks: 99, 99, 52
    expect(connection.getMultipleParsedAccounts).toHaveBeenCalledTimes(3);
  });

  it("returns results in the same order as keys", async () => {
    const keys = Array.from({ length: 150 }, (_, i) => new PublicKey(i + 1));
    const connection = {
      getMultipleParsedAccounts: vi.fn(async (chunk: PublicKey[]) => {
        return { value: chunk.map((key) => ({ data: key.toBase58() })) };
      }),
    };
    const result = await getMultipleChunked(connection, keys);
    expect(result).toHaveLength(150);
    expect(result[0]).toEqual({ data: keys.at(0)?.toBase58() });
    expect(result[149]).toEqual({ data: keys.at(149)?.toBase58() });
  });

  it("handles empty key list", async () => {
    const connection = {
      getMultipleParsedAccounts: vi.fn(async () => ({ value: [] })),
    };
    const result = await getMultipleChunked(connection, []);
    expect(result).toEqual([]);
    expect(connection.getMultipleParsedAccounts).not.toHaveBeenCalled();
  });

  it("handles exactly 99 keys in one call", async () => {
    const keys = Array.from({ length: 99 }, (_, i) => new PublicKey(i + 1));
    const connection = {
      getMultipleParsedAccounts: vi.fn(async () => ({ value: keys.map(() => null) })),
    };
    await getMultipleChunked(connection, keys);
    expect(connection.getMultipleParsedAccounts).toHaveBeenCalledTimes(1);
  });
});

describe("wsUrlFor (P1-2)", () => {
  it("maps http(s) to ws(s), keeping host, path and query", () => {
    expect(wsUrlFor("https://devnet.example-rpc.com/?api-key=abc")).toBe(
      "wss://devnet.example-rpc.com/?api-key=abc",
    );
    expect(wsUrlFor("https://api.devnet.solana.com")).toBe("wss://api.devnet.solana.com/");
  });

  it("moves an explicit port up by one, like web3.js (local validator 8899 -> 8900)", () => {
    expect(wsUrlFor("http://127.0.0.1:8899")).toBe("ws://127.0.0.1:8900/");
  });

  it("is null for anything that cannot carry a socket", () => {
    expect(wsUrlFor("/api/rpc")).toBeNull();
    expect(wsUrlFor("ftp://x.example")).toBeNull();
    expect(wsUrlFor("not a url")).toBeNull();
  });
});

describe("connectionFetcher (P1-2)", () => {
  const keys = Array.from({ length: 150 }, (_, i) => new PublicKey(i + 1).toBase58());

  it("reads in chunks of <= 99 keys, in order, reporting the oldest slot", async () => {
    const getMultipleAccountsInfoAndContext = vi.fn((chunk: PublicKey[]) =>
      Promise.resolve({
        context: { slot: chunk.length === 99 ? 500 : 400 },
        value: chunk.map((key, i) =>
          i % 2 === 0 ? null : { data: Buffer.from([key.toBytes()[31] ?? 0]) },
        ),
      }),
    );
    const fetchMany = connectionFetcher({
      getMultipleAccountsInfoAndContext,
    } as unknown as Parameters<typeof connectionFetcher>[0]);
    const { slot, values } = await fetchMany(keys);
    expect(getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(2);
    expect(getMultipleAccountsInfoAndContext.mock.calls[0]?.[0]).toHaveLength(99);
    expect(slot).toBe(400);
    expect(values).toHaveLength(150);
    expect(values[0]).toBeNull();
    expect(values[1]).toEqual(Buffer.from([2]));
  });

  it("answers an empty key list without a request", async () => {
    const getMultipleAccountsInfoAndContext = vi.fn();
    const fetchMany = connectionFetcher({
      getMultipleAccountsInfoAndContext,
    } as unknown as Parameters<typeof connectionFetcher>[0]);
    expect(await fetchMany([])).toEqual({ slot: 0, values: [] });
    expect(getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
  });
});

describe("browserAccountSocket / sharedAccountFeed (P1-2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has no socket without a WebSocket or for a proxy path", () => {
    vi.stubGlobal("WebSocket", undefined);
    expect(browserAccountSocket("https://rpc.example")).toBeNull();
    vi.unstubAllGlobals();
    vi.stubGlobal("WebSocket", vi.fn());
    expect(browserAccountSocket("/api/rpc")).toBeNull();
    expect(browserAccountSocket("https://rpc.example")).not.toBeNull();
  });

  it("returns one feed per RPC URL", () => {
    expect(sharedAccountFeed("http://127.0.0.1:1")).toBe(sharedAccountFeed("http://127.0.0.1:1"));
    expect(sharedAccountFeed("http://127.0.0.1:1")).not.toBe(
      sharedAccountFeed("http://127.0.0.1:2"),
    );
  });
});
