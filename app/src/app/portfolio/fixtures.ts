/** Shared fixtures for the Portfolio tests. */
import { PublicKey } from "@solana/web3.js";

import type { MeridianEvent } from "@/lib/events";
import type { MarketRow } from "@/lib/markets";
import { market } from "@/test-utils";

import type { Holdings, PortfolioSnapshot } from "./data";

export const WALLET = "Wallet1111111111111111111111111111111111111";
export const OTHER = "Other11111111111111111111111111111111111111";

/** Unix seconds for a UTC ISO string. */
const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export const NVDA = market({
  address: PublicKey.unique().toBase58(),
  ticker: "NVDA",
  tradingDate: 20261008,
  strikeCents: 18_000n,
  closeTs: BigInt(utc("2026-10-08T20:00:00Z")), // Session close 16:00 ET
});
export const AAPL: MarketRow = market({
  address: PublicKey.unique().toBase58(),
  ticker: "AAPL",
  tradingDate: 20261007,
  strikeCents: 23_000n,
  closeTs: BigInt(utc("2026-10-07T20:00:00Z")), // Session close 16:00 ET
  settled: true,
  outcome: "Yes",
  settlePriceScaled: 231_020_000_000_000_000_000n,
});
export const MSFT: MarketRow = market({
  address: PublicKey.unique().toBase58(),
  ticker: "MSFT",
  tradingDate: 20261007,
  strikeCents: 50_000n,
  closeTs: BigInt(utc("2026-10-07T20:00:00Z")), // Session close 16:00 ET
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

/** Wallet holdings of `yes` and `no` tokens, each in one token account. */
export const held = (yes: bigint, no: bigint): Holdings => ({
  yes,
  no,
  yesAccounts: yes > 0n ? [{ account: PublicKey.unique().toBase58(), amount: yes }] : [],
  noAccounts: no > 0n ? [{ account: PublicKey.unique().toBase58(), amount: no }] : [],
});

export const snapshot = (overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot => ({
  holdings: {},
  openOrders: [],
  resting: [],
  events: [],
  eventsPartial: false,
  usdcAccount: null,
  ...overrides,
});
