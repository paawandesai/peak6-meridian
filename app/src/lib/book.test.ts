// @vitest-environment node
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  calls: [] as { method: string; count: number }[],
  value: null as null | { data: Uint8Array },
}));

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  class FakeConnection {
    commitment = "confirmed";
    getMultipleAccountsInfoAndContext(keys: unknown[]) {
      rpc.calls.push({ method: "getMultipleAccountsInfoAndContext", count: keys.length });
      return Promise.resolve({ context: { slot: 1 }, value: keys.map(() => rpc.value) });
    }
    getMultipleAccountsInfo(keys: unknown[]) {
      rpc.calls.push({ method: "getMultipleAccountsInfo", count: keys.length });
      return Promise.resolve(keys.map(() => rpc.value));
    }
  }
  return { ...actual, Connection: FakeConnection };
});

import { createAccountFeed } from "./account-feed";
import { fakeFetcher } from "./account-test-support";
import { createBookSource, createLiveBookSource } from "./book";
import { findBookPda } from "@meridian/client";
import { encodeBook } from "@/app/trade/_lib/test-support";
import { parsePublicConfig } from "./config";

beforeEach(() => {
  rpc.calls.length = 0;
  rpc.value = null;
});

describe("createBookSource", () => {
  it("reads the book accounts in one batched call and maps a missing book to null", async () => {
    const config = parsePublicConfig({ rpcUrl: "http://127.0.0.1:8899" });
    const marketA = new PublicKey("11111111111111111111111111111112");
    const marketB = new PublicKey("11111111111111111111111111111113");
    const quotes = await createBookSource(config)([marketA, marketB]);
    expect(quotes).toEqual({ [marketA.toBase58()]: null, [marketB.toBase58()]: null });
    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0]?.count).toBe(2);
  });
});

describe("createLiveBookSource (P1-2)", () => {
  it("decodes quotes from the feed's book bytes; missing or garbage books are null", async () => {
    const config = parsePublicConfig({ rpcUrl: "http://127.0.0.1:8899" });
    const [a, b, c] = [2, 3, 4].map((n) => new PublicKey(n));
    if (a === undefined || b === undefined || c === undefined) throw new Error("keys");
    const bookOf = (market: PublicKey) => findBookPda(market, config.programId).address.toBase58();
    const fetcher = fakeFetcher({
      [bookOf(a)]: [...encodeBook([[58, 30]], [[61, 40]])],
      [bookOf(c)]: [1, 2, 3],
    });
    const feed = createAccountFeed({
      fetchMany: fetcher.fetchMany,
      socket: null,
      isVisible: () => true,
      onVisible: () => () => undefined,
    });
    const source = createLiveBookSource(config, feed)([a, b, c], 2_000);
    const stop = source.subscribe(() => undefined);
    await feed.refresh();
    expect(source.read()).toEqual({
      status: "ready",
      value: {
        [a.toBase58()]: { yesBid: 58, yesAsk: 61, yesMid: 59, noPrice: 41 },
        [b.toBase58()]: null,
        [c.toBase58()]: null,
      },
    });
    expect(fetcher.state.calls).toEqual([[bookOf(a), bookOf(b), bookOf(c)]]);
    stop();
    feed.dispose();
  });
});
