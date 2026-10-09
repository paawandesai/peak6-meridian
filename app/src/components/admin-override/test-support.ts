/** Fixtures for the override tests: drafts in the ops-agent shape and the market they name. */
import { PublicKey } from "@solana/web3.js";

import type { Draft } from "./drafts";
import { market } from "@/test-utils";

export const MARKET_ADDRESS = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
export const OTHER_ADDRESS = new PublicKey(new Uint8Array(32).fill(8)).toBase58();

/** 2026-10-08 16:00 ET close (EDT) = 20:00Z. */
export const CLOSE = 1_791_489_600;
export const DELAY = 3600;

export const NVDA = market({
  address: MARKET_ADDRESS,
  ticker: "NVDA",
  strikeCents: 18_000n,
  tradingDate: 20261008,
  closeTs: BigInt(CLOSE),
});

export function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    incident_id: "inc-1",
    market: MARKET_ADDRESS,
    proposed_price_cents: 18_142,
    sources: [
      { name: "tiingo", close: 18_140, as_of: new Date((CLOSE + 300) * 1000).toISOString() },
      { name: "twelvedata", close: 18_144, as_of: new Date((CLOSE + 360) * 1000).toISOString() },
    ],
    spread_bps: 2,
    note: "Both sources report the 2026-10-08 close; the settle job failed on an oracle timeout.",
    status: "pending_approval",
    ...overrides,
  };
}
