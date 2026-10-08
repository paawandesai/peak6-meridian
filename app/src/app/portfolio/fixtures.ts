/** Shared fixtures for the Portfolio tests. */
import { PublicKey } from "@solana/web3.js";

import type { MeridianEvent } from "@/lib/events";
import type { MarketRow } from "@/lib/markets";
import { market } from "@/test-utils";

import type { PortfolioSnapshot } from "./data";

export const WALLET = "Wallet1111111111111111111111111111111111111";
export const OTHER = "Other11111111111111111111111111111111111111";

export const NVDA = market({
  address: PublicKey.unique().toBase58(),
  ticker: "NVDA",
  tradingDate: 20261008,
  strikeCents: 18_000n,
  closeTs: 2_000_000_000n,
});
export const AAPL: MarketRow = market({
  address: PublicKey.unique().toBase58(),
  ticker: "AAPL",
  tradingDate: 20261007,
  strikeCents: 23_000n,
  settled: true,
  outcome: "Yes",
  settlePriceScaled: 231_020_000_000_000_000_000n,
});
export const MSFT: MarketRow = market({
  address: PublicKey.unique().toBase58(),
  ticker: "MSFT",
  tradingDate: 20261007,
  strikeCents: 50_000n,
  settled: true,
  outcome: "No",
  settlePriceScaled: 480_000_000_000_000_000_000n,
});

let sequence = 0;
export const fill = (
  signature: string,
  marketAddress: string,
  o: { taker: string; maker: string; takerSide: "Bid" | "Ask"; price: number; qty: bigint },
): MeridianEvent => ({
  kind: "Fill",
  signature,
  blockTime: 1_790_000_000 + sequence++,
  market: marketAddress,
  ...o,
});

export const snapshot = (overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot => ({
  holdings: {},
  openOrders: [],
  resting: [],
  events: [],
  eventsPartial: false,
  ...overrides,
});
