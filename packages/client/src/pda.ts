/**
 * PDA derivations matching the seeds in docs/architecture.md § Data model and the constants in
 * `programs/meridian/src/state`. Every derivation takes an optional program ID so the same
 * helpers serve localnet and devnet deployments.
 */
import { PublicKey } from "@solana/web3.js";

import { MERIDIAN_PROGRAM_ID } from "./program";
import { assertStrikeCents, parseTradingDate } from "./units";

/** Length of the zero-padded ticker symbol on-chain. */
export const SYMBOL_LEN = 8;

/** Seed prefixes, byte for byte as in `programs/meridian/src/state`. */
export const SEEDS = {
  config: "config",
  market: "market",
  yesMint: "yes",
  noMint: "no",
  vault: "vault",
  escrowUsdc: "escrow_usdc",
  escrowYes: "escrow_yes",
  book: "book",
  openOrders: "oo",
} as const;

export type PdaResult = { readonly address: PublicKey; readonly bump: number };

/** Identifies one market: ticker symbol, ET trading date (`YYYYMMDD`) and strike in cents. */
export type MarketKey = {
  readonly symbol: string;
  readonly tradingDate: number;
  readonly strikeCents: bigint;
};

const encoder = new TextEncoder();

/** The ticker as 8 zero-padded bytes; throws unless it is 1–8 upper-case ASCII letters. */
export function symbolBytes(symbol: string): Uint8Array {
  if (!/^[A-Z]{1,8}$/.test(symbol)) {
    throw new Error(
      `ticker symbol must be 1-8 upper-case ASCII letters: ${JSON.stringify(symbol)}`,
    );
  }
  const bytes = new Uint8Array(SYMBOL_LEN);
  bytes.set(encoder.encode(symbol));
  return bytes;
}

/** The symbol stored in an on-chain `[u8; 8]`, without its zero padding. */
export function symbolFromBytes(bytes: ArrayLike<number>): string {
  const end = Array.from(bytes).indexOf(0);
  return String.fromCharCode(...Array.from(bytes).slice(0, end === -1 ? bytes.length : end));
}

/** Little-endian `u32`. */
export function u32Le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`not a u32: ${value}`);
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

/** Little-endian `u64`. */
export function u64Le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`not a u64: ${value}`);
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function find(seeds: Uint8Array[], programId: PublicKey): PdaResult {
  const [address, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return { address, bump };
}

/** `["config"]` */
export function findConfigPda(programId: PublicKey = MERIDIAN_PROGRAM_ID): PdaResult {
  return find([encoder.encode(SEEDS.config)], programId);
}

/** `["market", symbol, trading_date_le, strike_cents_le]` */
export function findMarketPda(
  key: MarketKey,
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): PdaResult {
  parseTradingDate(key.tradingDate);
  return find(
    [
      encoder.encode(SEEDS.market),
      symbolBytes(key.symbol),
      u32Le(key.tradingDate),
      u64Le(assertStrikeCents(key.strikeCents)),
    ],
    programId,
  );
}

function findForMarket(seed: string, market: PublicKey, programId: PublicKey): PdaResult {
  return find([encoder.encode(seed), market.toBytes()], programId);
}

/** `["yes", market]` */
export function findYesMintPda(
  market: PublicKey,
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): PdaResult {
  return findForMarket(SEEDS.yesMint, market, programId);
}

/** `["no", market]` */
export function findNoMintPda(
  market: PublicKey,
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): PdaResult {
  return findForMarket(SEEDS.noMint, market, programId);
}

/** `["vault", market]` */
export function findVaultPda(
  market: PublicKey,
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): PdaResult {
  return findForMarket(SEEDS.vault, market, programId);
}

/** `["escrow_usdc", market]` */
export function findEscrowUsdcPda(
  market: PublicKey,
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): PdaResult {
  return findForMarket(SEEDS.escrowUsdc, market, programId);
}

/** `["escrow_yes", market]` */
export function findEscrowYesPda(
  market: PublicKey,
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): PdaResult {
  return findForMarket(SEEDS.escrowYes, market, programId);
}

/** `["book", market]` */
export function findBookPda(
  market: PublicKey,
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): PdaResult {
  return findForMarket(SEEDS.book, market, programId);
}

/** `["oo", market, owner]` */
export function findOpenOrdersPda(
  market: PublicKey,
  owner: PublicKey,
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): PdaResult {
  return find([encoder.encode(SEEDS.openOrders), market.toBytes(), owner.toBytes()], programId);
}

/** Every program-derived address of one market. */
export type MarketAddresses = {
  readonly market: PublicKey;
  readonly yesMint: PublicKey;
  readonly noMint: PublicKey;
  readonly vault: PublicKey;
  readonly escrowUsdc: PublicKey;
  readonly escrowYes: PublicKey;
  readonly book: PublicKey;
};

/** All addresses of the market identified by `key`. */
export function marketAddresses(
  key: MarketKey,
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): MarketAddresses {
  const market = findMarketPda(key, programId).address;
  return {
    market,
    yesMint: findYesMintPda(market, programId).address,
    noMint: findNoMintPda(market, programId).address,
    vault: findVaultPda(market, programId).address,
    escrowUsdc: findEscrowUsdcPda(market, programId).address,
    escrowYes: findEscrowYesPda(market, programId).address,
    book: findBookPda(market, programId).address,
  };
}
