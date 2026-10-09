import { PublicKey } from "@solana/web3.js";
import type { ReactNode } from "react";

import { ReaderProvider } from "@/components/reader-context";
import type { MeridianReader } from "@/lib/chain";
import type { MarketRow } from "@/lib/markets";

export function market(overrides: Partial<MarketRow> = {}): MarketRow {
  const row: MarketRow = {
    address: "Mkt1111111111111111111111111111111111111111",
    ticker: "AAPL",
    tradingDate: 20260105,
    strikeCents: 22_000n,
    closeTs: 2_000_000_000n,
    settled: false,
    outcome: "None",
    settlePriceScaled: 0n,
    pairsOutstanding: 3n,
    settledAt: 0n,
    ...overrides,
  };
  // A settled market without explicit values gets a defined outcome and price, so its Settled
  // badge text exists (`Settled YES at $181.00`).
  return row.settled
    ? {
        ...row,
        outcome: overrides.outcome ?? "Yes",
        settlePriceScaled: overrides.settlePriceScaled ?? 181_000_000_000_000_000_000n,
        settledAt: overrides.settledAt ?? 2_000_000_300n,
      }
    : row;
}

export const OWNER = new PublicKey("11111111111111111111111111111112");
/** The Config admin in tests. */
export const ADMIN = new PublicKey("11111111111111111111111111111113");

export function reader(overrides: Partial<MeridianReader> = {}): MeridianReader {
  return {
    listMarkets: () => Promise.resolve([]),
    getConfig: () =>
      Promise.resolve({ paused: false, overrideDelaySecs: 3600n, admin: ADMIN.toBase58() }),
    usdcBalance: () => Promise.resolve(0n),
    ...overrides,
  };
}

export function withReader(value: MeridianReader, children: ReactNode) {
  return <ReaderProvider reader={value}>{children}</ReaderProvider>;
}
