// @vitest-environment node
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { connectionChain } from "./chain";

type FakeConnection = Parameters<typeof connectionChain>[0];

function connection(overrides: Record<string, unknown>): FakeConnection {
  return {
    getSlot: () => Promise.resolve(100),
    getBlockTime: () => Promise.resolve(1_700_000_000),
    ...overrides,
  } as unknown as FakeConnection;
}

describe("connectionChain", () => {
  it("reads cluster time from the latest confirmed block, looking back past slots without a time", async () => {
    const getBlockTime = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(1_700_000_123);
    const chain = connectionChain(connection({ getBlockTime }));
    expect(await chain.clusterUnixTime()).toBe(1_700_000_123);
    expect(getBlockTime.mock.calls.map((c) => c[0])).toEqual([100, 99, 98]);
  });

  it("fails when the cluster reports no block time at all", async () => {
    const chain = connectionChain(connection({ getBlockTime: () => Promise.resolve(null) }));
    await expect(chain.clusterUnixTime()).rejects.toThrow("no block time");
  });

  it("delegates the simple reads and surfaces the simulation error", async () => {
    const key = Keypair.generate().publicKey;
    const chain = connectionChain(
      connection({
        getGenesisHash: () => Promise.resolve("genesis"),
        getBalance: () => Promise.resolve(42),
        getMinimumBalanceForRentExemption: () => Promise.resolve(890_880),
        getLatestBlockhash: () => Promise.resolve({ blockhash: "b", lastValidBlockHeight: 9 }),
        simulateTransaction: () =>
          Promise.resolve({ value: { err: { InstructionError: [1, { Custom: 0 }] } } }),
      }),
    );
    expect(await chain.getGenesisHash()).toBe("genesis");
    expect(await chain.getBalance(key)).toBe(42);
    expect(await chain.getMinimumBalanceForRentExemption(1)).toBe(890_880);
    expect(await chain.getLatestBlockhash()).toEqual({ blockhash: "b", lastValidBlockHeight: 9 });
    expect(await chain.simulate({} as never)).toEqual({
      err: { InstructionError: [1, { Custom: 0 }] },
    });
  });

  it("sends once without preflight or retries, and maps confirmation, failure and expiry", async () => {
    const sendRawTransaction = vi.fn().mockResolvedValue("sig");
    const confirmTransaction = vi
      .fn()
      .mockResolvedValueOnce({ value: { err: null } })
      .mockResolvedValueOnce({ value: { err: { InstructionError: [1, { Custom: 0 }] } } })
      .mockRejectedValueOnce(
        Object.assign(new Error("expired"), { name: "TransactionExpiredBlockheightExceededError" }),
      )
      .mockRejectedValueOnce(new Error("rpc down"));
    const chain = connectionChain(connection({ sendRawTransaction, confirmTransaction }));
    const tx = { serialize: () => Buffer.from([1, 2, 3]) } as never;
    expect(await chain.send(tx)).toBe("sig");
    expect(sendRawTransaction).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), {
      skipPreflight: true,
      maxRetries: 0,
    });
    const info = { blockhash: "b", lastValidBlockHeight: 9 };
    expect(await chain.confirm("sig", info)).toEqual({ err: null, expired: false });
    expect(await chain.confirm("sig", info)).toEqual({
      err: { InstructionError: [1, { Custom: 0 }] },
      expired: false,
    });
    expect(await chain.confirm("sig", info)).toEqual({ err: null, expired: true });
    await expect(chain.confirm("sig", info)).rejects.toThrow("rpc down");
  });
});
