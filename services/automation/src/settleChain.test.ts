import type { Program } from "@coral-xyz/anchor";
import { BN, type Meridian, symbolBytes } from "@meridian/client";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { programSettleChain } from "./settleChain";

const market = (ticker: string, status: object, strike: number) => ({
  publicKey: Keypair.generate().publicKey,
  account: {
    ticker: Array.from(symbolBytes(ticker)),
    tradingDate: 20_261_006,
    closeTs: new BN(1_791_316_800),
    strikeCents: new BN(strike),
    status,
  },
});

describe("programSettleChain", () => {
  const tiingo = Keypair.generate().publicKey;
  const twelve = Keypair.generate().publicKey;
  const payer = Keypair.generate().publicKey;
  const open = market("META", { open: {} }, 68_000);
  const program = {
    account: {
      market: { all: () => Promise.resolve([open, market("META", { settled: {} }, 70_000)]) },
      config: {
        fetch: () =>
          Promise.resolve({
            maxStalenessSlots: new BN(30),
            tickers: [
              { symbol: Array.from(symbolBytes("META")), feeds: [tiingo, twelve] },
              { symbol: Array(8).fill(0), feeds: [tiingo, twelve] },
            ],
          }),
      },
    },
    provider: { connection: { getBalance: () => Promise.resolve(123) } },
  } as unknown as Program<Meridian>;
  const chain = programSettleChain(program, Keypair.generate().publicKey, payer);

  it("lists only open markets, decoded", async () => {
    expect(await chain.openMarkets()).toEqual([
      {
        address: open.publicKey,
        ticker: "META",
        tradingDate: 20_261_006,
        closeTs: 1_791_316_800,
        strikeCents: 68_000n,
      },
    ]);
  });

  it("reads the pinned feeds per configured ticker and the staleness budget", async () => {
    const pinned = await chain.pinnedFeeds();
    expect(Object.keys(pinned.feeds)).toEqual(["META"]);
    expect(pinned.feeds.META).toEqual([tiingo, twelve]);
    expect(pinned.maxStalenessSlots).toBe(30);
  });

  it("reads the payer balance", async () => {
    expect(await chain.balanceLamports()).toBe(123);
  });
});
