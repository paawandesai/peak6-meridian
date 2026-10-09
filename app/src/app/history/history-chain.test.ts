// @vitest-environment node
// web3.js PDA derivation needs Node's own Uint8Array realm (jsdom's differs).
import { findOpenOrdersPda } from "@meridian/client";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { loadWalletEvents, openOrdersAddresses, type HistoryRpc } from "./history-chain";
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
