import { PublicKey } from "@solana/web3.js";
import type { ReactNode } from "react";

import { ReaderProvider } from "@/components/reader-context";
import type { MeridianReader } from "@/lib/chain";
import type { MarketRow } from "@/lib/markets";

export function market(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    address: "Mkt1111111111111111111111111111111111111111",
    ticker: "AAPL",
    tradingDate: 20260105,
    strikeCents: 22_000n,
    closeTs: 2_000_000_000n,
    settled: false,
    pairsOutstanding: 3n,
    ...overrides,
  };
}

export const OWNER = new PublicKey("11111111111111111111111111111112");

export function reader(overrides: Partial<MeridianReader> = {}): MeridianReader {
  return {
    listMarkets: () => Promise.resolve([]),
    usdcBalance: () => Promise.resolve(0n),
    ...overrides,
  };
}

export function withReader(value: MeridianReader, children: ReactNode) {
  return <ReaderProvider reader={value}>{children}</ReaderProvider>;
}
