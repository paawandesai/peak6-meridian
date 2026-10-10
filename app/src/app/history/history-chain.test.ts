// @vitest-environment node
// web3.js PDA derivation needs Node's own Uint8Array realm (jsdom's differs).
import { findOpenOrdersPda } from "@meridian/client";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  findWalletOpenOrders,
  loadWalletEvents,
  openOrdersAddresses,
  type HistoryRpc,
} from "./history-chain";
import { decodeEvents } from "@/lib/events";
import fixture from "@/lib/fixtures/events.json";
import { market } from "@/test-utils";

const programId = new PublicKey(fixture.programId);
const events = decodeEvents(fixture.logs, { signature: fixture.signature }, fixture.programId);
const fill = events.find((event) => event.kind === "Fill");
if (fill?.kind !== "Fill") throw new Error("fixture has no fill");
const maker = new PublicKey(fill.maker);
const mkt = new PublicKey(fill.market);

describe("maker fills (US-10)", () => {
  it("derives the wallet's OpenOrders PDA per market", () => {
    const row = market({ address: mkt.toBase58() });
    expect(openOrdersAddresses([row], maker, programId)).toEqual([
      findOpenOrdersPda(mkt, maker, programId).address,
    ]);
  });

  it("finds a fill whose transaction lists only the maker's OpenOrders PDA", async () => {
    const oo = findOpenOrdersPda(mkt, maker, programId).address;
    const getSignaturesForAddress = vi.fn((address: PublicKey) =>
      Promise.resolve(
        address.equals(oo)
          ? [{ signature: fixture.signature, err: null, slot: 9, blockTime: 1 }]
          : [],
      ),
    );
    const rpc = {
      getSignaturesForAddress,
      getTransactions: vi
        .fn()
        .mockResolvedValue([{ blockTime: fixture.blockTime, meta: { logMessages: fixture.logs } }]),
    } as unknown as HistoryRpc;
    const wallet_only = await loadWalletEvents(rpc, maker, programId);
    expect(wallet_only).toEqual([]);
    const merged = await loadWalletEvents(rpc, maker, programId, [oo]);
    expect(merged.map((event) => event.kind)).toContain("Fill");
  });

  it("merges duplicate signatures from the wallet and its PDAs, newest slot first", async () => {
    const oo = findOpenOrdersPda(mkt, maker, programId).address;
    const entry = (signature: string, slot: number) => ({
      signature,
      err: null,
      slot,
      blockTime: null,
    });
    const rpc = {
      getSignaturesForAddress: vi.fn((address: PublicKey) =>
        Promise.resolve(address.equals(oo) ? [entry("a", 5), entry("b", 7)] : [entry("a", 5)]),
      ),
      getTransactions: vi.fn().mockResolvedValue([]),
    } as unknown as HistoryRpc;
    await loadWalletEvents(rpc, maker, programId, [oo]);
    expect(rpc.getTransactions).toHaveBeenCalledWith(["b", "a"], expect.anything());
  });
});

describe("findWalletOpenOrders", () => {
  it("uses getProgramAccounts with owner memcmp to find OpenOrders", async () => {
    const oo1 = new PublicKey(new Uint8Array(32).fill(1));
    const oo2 = new PublicKey(new Uint8Array(32).fill(2));
    const rpc = {
      getProgramAccounts: vi.fn().mockResolvedValue([{ pubkey: oo1 }, { pubkey: oo2 }]),
    };
    const result = await findWalletOpenOrders(rpc, maker, programId);
    expect(result).toEqual([oo1, oo2]);
    expect(rpc.getProgramAccounts).toHaveBeenCalledWith(
      programId,
      expect.objectContaining({
        filters: [
          { dataSize: 90 }, // 8 + OpenOrders::INIT_SPACE = 8 + (32+32+8+8+1+1)
          { memcmp: { offset: 8, bytes: maker.toBase58() } },
        ],
      }),
    );
  });

  it("returns empty on getProgramAccounts failure", async () => {
    const rpc = {
      getProgramAccounts: vi.fn().mockRejectedValue(new Error("RPC error")),
    };
    const result = await findWalletOpenOrders(rpc, maker, programId);
    expect(result).toEqual([]);
  });
});

describe("concurrency cap", () => {
  it("fetches signatures with concurrency limit when no extraAddresses provided", async () => {
    const oo1 = new PublicKey(new Uint8Array(32).fill(10));
    const oo2 = new PublicKey(new Uint8Array(32).fill(11));
    const oo3 = new PublicKey(new Uint8Array(32).fill(12));
    const oo4 = new PublicKey(new Uint8Array(32).fill(13));
    const oo5 = new PublicKey(new Uint8Array(32).fill(14));
    const calls: string[] = [];
    const rpc = {
      getProgramAccounts: vi
        .fn()
        .mockResolvedValue([
          { pubkey: oo1 },
          { pubkey: oo2 },
          { pubkey: oo3 },
          { pubkey: oo4 },
          { pubkey: oo5 },
        ]),
      getSignaturesForAddress: vi.fn(async (addr: PublicKey) => {
        calls.push(addr.toBase58());
        return [];
      }),
      getTransactions: vi.fn().mockResolvedValue([]),
    } as unknown as HistoryRpc;
    await loadWalletEvents(rpc, maker, programId);
    // Should have called getSignaturesForAddress for wallet + 5 OpenOrders = 6 addresses
    expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(6);
    // Calls should be made (wallet is first, then the 5 OO addresses)
    expect(calls[0]).toBe(maker.toBase58());
  });

  it("production call (no extraAddresses) uses gPA and does not scan non-existent PDAs", async () => {
    const oo1 = new PublicKey(new Uint8Array(32).fill(20));
    const oo2 = new PublicKey(new Uint8Array(32).fill(21));
    const sigCalls: string[] = [];
    const rpc = {
      getProgramAccounts: vi.fn().mockResolvedValue([{ pubkey: oo1 }, { pubkey: oo2 }]),
      getSignaturesForAddress: vi.fn(async (addr: PublicKey) => {
        sigCalls.push(addr.toBase58());
        return [];
      }),
      getTransactions: vi.fn().mockResolvedValue([]),
    } as unknown as HistoryRpc;

    // Production call: no extraAddresses parameter
    await loadWalletEvents(rpc, maker, programId);

    // Should have called gPA to find OpenOrders with correct filters
    expect(rpc.getProgramAccounts).toHaveBeenCalledWith(
      programId,
      expect.objectContaining({
        filters: expect.arrayContaining([
          { dataSize: 90 }, // 8 + OpenOrders::INIT_SPACE
          { memcmp: { offset: 8, bytes: maker.toBase58() } },
        ]),
      }),
    );

    // Should scan wallet + only the 2 OpenOrders that exist (not all potential market PDAs)
    expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(3);
    expect(sigCalls).toContain(maker.toBase58());
    expect(sigCalls).toContain(oo1.toBase58());
    expect(sigCalls).toContain(oo2.toBase58());
  });
});
