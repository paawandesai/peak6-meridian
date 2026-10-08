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

import { createBookSource } from "./book";
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
