// @vitest-environment node
// web3.js PDA derivation needs Node's own Uint8Array realm (jsdom's differs).
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  loadMarketFacts,
  MAX_SETTLE_SCAN,
  loadStatusData,
  loadVaultBalances,
  type StatusRpc,
} from "./status-chain";
import fixture from "@/lib/fixtures/events.json";
import { NO_FACTS } from "@/lib/status";
import { market } from "@/test-utils";

const DATE = 20261008;
const good = market({ address: "Good", tradingDate: DATE, settled: true, outcome: "Yes" });
const bad = market({ address: "Bad", tradingDate: DATE });

describe("status-chain", () => {
  const programId = new PublicKey(fixture.programId);
  const MKT = new PublicKey(new Uint8Array(32).fill(9));
  const tx = { slot: 777, blockTime: fixture.blockTime, meta: { logMessages: fixture.logs } };
  const sig = (signature: string, err: unknown = null) => ({ signature, err, blockTime: null });
  const rpcWith = (over: Partial<Record<keyof StatusRpc, unknown>>): StatusRpc =>
    ({
      getMultipleParsedAccounts: vi.fn().mockResolvedValue({ value: [] }),
      getSignaturesForAddress: vi.fn().mockResolvedValue([]),
      getTransactions: vi.fn().mockResolvedValue([]),
      ...over,
    }) as unknown as StatusRpc;
  const parsed = (amount: string) => ({ data: { parsed: { info: { tokenAmount: { amount } } } } });

  it("reads vault balances and maps unreadable vaults to null", async () => {
    const rpc = rpcWith({
      getMultipleParsedAccounts: vi.fn().mockResolvedValue({ value: [parsed("5000000"), null] }),
    });
    const key = MKT.toBase58();
    const key2 = new PublicKey(new Uint8Array(32).fill(8)).toBase58();
    const out = await loadVaultBalances(
      rpc,
      [
        { ...good, address: key },
        { ...bad, address: key2 },
      ],
      programId,
    );
    expect([...out.values()]).toEqual([5_000_000n, null]);
  });

  const none = { blockTime: fixture.blockTime, slot: 1, meta: { logMessages: [] as string[] } };
  const byHash =
    (map: Record<string, unknown>) =>
    (sigs: string[]): Promise<unknown[]> =>
      Promise.resolve(sigs.map((s) => map[s] ?? null));

  it("derives creation from the oldest transaction and settlement from the one that emits it", async () => {
    const key = MKT.toBase58();
    const rpc = rpcWith({
      getSignaturesForAddress: vi
        .fn()
        .mockResolvedValue([
          sig("redeem2"),
          sig("redeem1"),
          sig("failed", { e: 1 }),
          sig("settle"),
          sig("old"),
        ]),
      getTransactions: vi
        .fn()
        .mockImplementation(byHash({ redeem2: none, redeem1: none, settle: tx, old: tx })),
    });
    const out = await loadMarketFacts(rpc, { ...good, address: key }, programId);
    expect(out).toMatchObject({ createdAt: fixture.blockTime, settleSlot: 777, oracleSlot: 321n });
    expect(out.settledAt).toBe(fixture.blockTime);
  });

  it("stops scanning once the settle transaction is found", async () => {
    const key = MKT.toBase58();
    const sigs = [sig("settle"), ...Array.from({ length: 30 }, (_, i) => sig(`later${i}`))];
    const rpc = rpcWith({
      getSignaturesForAddress: vi.fn().mockResolvedValue(sigs),
      getTransactions: vi.fn().mockImplementation(byHash({ settle: tx })),
    });
    await loadMarketFacts(rpc, { ...good, address: key }, programId);
    const fetched = (rpc.getTransactions as unknown as { mock: { calls: string[][][] } }).mock
      .calls;
    expect(fetched.flatMap((call) => call[0] ?? []).length).toBeLessThanOrEqual(1 + 8);
  });

  it("gives up after MAX_SETTLE_SCAN transactions and leaves settlement unavailable", async () => {
    const key = MKT.toBase58();
    const sigs = Array.from({ length: 200 }, (_, i) => sig(`s${i}`));
    const rpc = rpcWith({
      getSignaturesForAddress: vi.fn().mockResolvedValue(sigs),
      getTransactions: vi.fn().mockImplementation(byHash({})),
    });
    const out = await loadMarketFacts(rpc, { ...good, address: key }, programId);
    expect(out.settledAt).toBeNull();
    const calls = (rpc.getTransactions as unknown as { mock: { calls: string[][][] } }).mock.calls;
    expect(calls.flatMap((call) => call[0] ?? []).length).toBeLessThanOrEqual(1 + MAX_SETTLE_SCAN);
  });

  it("leaves creation unknown on a full signature page, and skips unsettled newest", async () => {
    const key = MKT.toBase58();
    const full = Array.from({ length: 1_000 }, (_, i) => sig(`s${i}`));
    const rpc = rpcWith({
      getSignaturesForAddress: vi.fn().mockResolvedValue(full),
      getTransactions: vi.fn().mockResolvedValue([]),
    });
    expect(await loadMarketFacts(rpc, { ...bad, address: key }, programId)).toEqual(NO_FACTS);
    expect(rpc.getTransactions).not.toHaveBeenCalled();
    const none = rpcWith({
      getTransactions: vi.fn().mockResolvedValue([null, { slot: 1, meta: { logMessages: null } }]),
      getSignaturesForAddress: vi.fn().mockResolvedValue([sig("a"), sig("b")]),
    });
    expect(await loadMarketFacts(none, { ...good, address: key }, programId)).toEqual(NO_FACTS);
  });

  it("loads only the newest two trading dates", async () => {
    const key = MKT.toBase58();
    const mk = (date: number) => market({ address: key, tradingDate: date });
    const rpc = rpcWith({
      getMultipleParsedAccounts: vi.fn().mockResolvedValue({ value: [parsed("0")] }),
    });
    const out = await loadStatusData(rpc, [mk(1), mk(3), mk(2)], programId);
    expect(out.markets.map((m) => m.tradingDate).sort()).toEqual([2, 3]);
    expect((await loadStatusData(rpc, [], programId)).markets).toEqual([]);
  });
});
