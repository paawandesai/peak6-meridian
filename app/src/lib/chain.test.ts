import { symbolBytes } from "@meridian/client";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { createReader, fetchMarkets, fetchUsdcBalance } from "./chain";
import { parsePublicConfig } from "./config";
import { OWNER } from "@/test-utils";

const num = (n: bigint | number) => ({ toString: () => n.toString() });

describe("fetchMarkets", () => {
  it("decodes on-chain accounts into rows", async () => {
    const rows = await fetchMarkets({
      all: () =>
        Promise.resolve([
          {
            publicKey: OWNER,
            account: {
              ticker: symbolBytes("MSFT"),
              tradingDate: 20260105,
              strikeCents: num(44_000n),
              closeTs: num(1_767_000_000n),
              pairsOutstanding: num(12n),
              status: { settled: {} },
            },
          },
          {
            publicKey: OWNER,
            account: {
              ticker: symbolBytes("AAPL"),
              tradingDate: 20260105,
              strikeCents: num(22_000n),
              closeTs: num(1_767_000_000n),
              pairsOutstanding: num(0n),
              status: { open: {} },
            },
          },
        ]),
    });
    expect(rows[0]).toEqual({
      address: OWNER.toBase58(),
      ticker: "MSFT",
      tradingDate: 20260105,
      strikeCents: 44_000n,
      closeTs: 1_767_000_000n,
      settled: true,
      pairsOutstanding: 12n,
    });
    expect(rows[1]?.settled).toBe(false);
  });

  it("propagates RPC failures", async () => {
    await expect(
      fetchMarkets({ all: () => Promise.reject(new Error("rpc down")) }),
    ).rejects.toThrow("rpc down");
  });
});

describe("fetchUsdcBalance", () => {
  const entry = (amount: string) => ({
    account: { data: { parsed: { info: { tokenAmount: { amount } } } } },
  });
  const connection = (value: unknown[]) => ({
    getParsedTokenAccountsByOwner: () => Promise.resolve({ context: { slot: 1 }, value }),
  });

  it("sums the owner's accounts in base units", async () => {
    const total = await fetchUsdcBalance(
      connection([entry("1500000"), entry("250000")]) as never,
      OWNER,
      OWNER,
    );
    expect(total).toBe(1_750_000n);
  });

  it("is zero without token accounts", async () => {
    expect(await fetchUsdcBalance(connection([]) as never, OWNER, OWNER)).toBe(0n);
  });

  it("rejects a malformed RPC response", async () => {
    await expect(fetchUsdcBalance(connection([{}]) as never, OWNER, OWNER)).rejects.toThrow();
  });
});

describe("createReader", () => {
  it("reports no balance when the mint is not configured", async () => {
    const reader = createReader(parsePublicConfig({}));
    expect(await reader.usdcBalance(new PublicKey(OWNER))).toBeNull();
  });
});
