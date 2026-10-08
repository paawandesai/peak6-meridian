// @vitest-environment node
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { createOpenTimeSource, creationBlockTime } from "./market-open";
import { parsePublicConfig } from "./config";

const key = PublicKey.unique();
const sigs = (n: number, start: number) =>
  Array.from({ length: n }, (_, i) => ({
    signature: `s${start + i}`,
    blockTime: 1_000 - (start + i),
  }));

describe("creationBlockTime", () => {
  it("is the block time of the oldest signature", async () => {
    const connection = { getSignaturesForAddress: vi.fn().mockResolvedValue(sigs(3, 0)) };
    expect(await creationBlockTime(connection as never, key)).toBe(1_000 - 2);
  });

  it("pages back through a long history to the oldest signature", async () => {
    const getSignaturesForAddress = vi
      .fn()
      .mockResolvedValueOnce(sigs(1_000, 0))
      .mockResolvedValueOnce(sigs(5, 1_000));
    expect(await creationBlockTime({ getSignaturesForAddress } as never, key)).toBe(1_000 - 1_004);
    expect(getSignaturesForAddress.mock.calls[1]?.[1]).toMatchObject({ before: "s999" });
  });

  it("is null for no history, an unknown block time and a history longer than the pages read", async () => {
    expect(
      await creationBlockTime({ getSignaturesForAddress: () => Promise.resolve([]) } as never, key),
    ).toBeNull();
    expect(
      await creationBlockTime(
        {
          getSignaturesForAddress: () => Promise.resolve([{ signature: "a", blockTime: null }]),
        } as never,
        key,
      ),
    ).toBeNull();
    expect(
      await creationBlockTime(
        { getSignaturesForAddress: () => Promise.resolve(sigs(1_000, 0)) } as never,
        key,
      ),
    ).toBeNull();
  });
});

describe("createOpenTimeSource", () => {
  const config = parsePublicConfig({ rpcUrl: "http://127.0.0.1:8899" });

  it("reads each address once and caches known creation times", async () => {
    const getSignaturesForAddress = vi.fn().mockResolvedValue(sigs(2, 0));
    const source = createOpenTimeSource(config, { getSignaturesForAddress } as never);
    const a = key.toBase58();
    expect(await source([a])).toEqual({ [a]: 999 });
    expect(await source([a])).toEqual({ [a]: 999 });
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });

  it("reports null for a failed read or invalid address and retries it next time", async () => {
    const getSignaturesForAddress = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc"))
      .mockResolvedValue(sigs(1, 0));
    const source = createOpenTimeSource(config, { getSignaturesForAddress } as never);
    const a = key.toBase58();
    expect(await source([a, "not-a-key"])).toEqual({ [a]: null, "not-a-key": null });
    expect(await source([a])).toEqual({ [a]: 1_000 });
  });
});
