/**
 * Regenerates `src/lib/fixtures/events.json`: program-log lines for every wallet event, built with
 * the generated client's Borsh event coder (the same encoding `emit!` writes as `Program data:`),
 * plus an unknown event, a malformed line and a config event the wallet feed skips.
 * Run: `pnpm --filter app exec tsx scripts/gen-events-fixture.ts`. Fixed keys, no network.
 */
import { writeFileSync } from "node:fs";

import { BorshCoder } from "@coral-xyz/anchor";
import { BN, MERIDIAN_IDL, MERIDIAN_PROGRAM_ID, symbolBytes } from "@meridian/client";
import { PublicKey } from "@solana/web3.js";

const key = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
const coder = new BorshCoder(MERIDIAN_IDL);
const programId = MERIDIAN_PROGRAM_ID.toBase58();
/** `Program data:` payload: the 8-byte event discriminator from the IDL + the Borsh struct. */
const line = (name: string, data: object): string => {
  const event = MERIDIAN_IDL.events?.find((candidate) => candidate.name === name);
  if (event === undefined) throw new Error(`no event ${name} in the IDL`);
  const body = coder.types.encode(name, data);
  return `Program data: ${Buffer.concat([Buffer.from(event.discriminator), body]).toString("base64")}`;
};

const market = key(1);
const logs = [
  `Program ${programId} invoke [1]`,
  line("MarketCreated", {
    market,
    ticker: Array.from(symbolBytes("AAPL")),
    strike_cents: new BN(23_000),
    trading_date: 20261008,
    close_ts: new BN(1_791_492_000),
    yes_mint: key(2),
    no_mint: key(3),
  }),
  line("PairsMinted", { market, user: key(4), qty: new BN(20), pairs_outstanding: new BN(20) }),
  line("OrderPlaced", {
    market,
    owner: key(4),
    order_id: new BN(7),
    side: { Ask: {} },
    price: 60,
    qty: new BN(10),
    rested_qty: new BN(10),
  }),
  line("Fill", {
    market,
    maker: key(4),
    taker: key(5),
    price: 60,
    qty: new BN(10),
    taker_side: { Bid: {} },
  }),
  line("OrderCancelled", { market, owner: key(4), order_id: new BN(8), qty: new BN(5) }),
  line("FundsSettled", { market, owner: key(5), usdc: new BN(0), yes: new BN(10) }),
  line("MarketSettled", {
    market,
    outcome: { Yes: {} },
    price: new BN(700),
    source: { Oracle: {} },
    oracle_slot: new BN(321),
  }),
  line("Redeemed", {
    market,
    user: key(5),
    yes_qty: new BN(10),
    no_qty: new BN(0),
    usdc: new BN(10_000_000),
  }),
  `Program ${programId} consumed 12345 of 200000 compute units`,
  `Program ${programId} success`,
];

writeFileSync(
  new URL("../src/lib/fixtures/events.json", import.meta.url),
  `${JSON.stringify({ programId, signature: "5".repeat(87), blockTime: 1_791_490_000, logs }, null, 2)}\n`,
);
