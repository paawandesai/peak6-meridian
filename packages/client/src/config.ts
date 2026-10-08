/**
 * Config parameters for `initialize_config` / `update_config`. A ticker is 136 bytes, so the
 * seven MAG7 tickers (952 bytes) cannot ride in one 1,232-byte transaction: each call carries
 * at most six ticker slots, and slots not listed keep their value (empty after initialise).
 */
import { BN } from "./bn";
import { PublicKey } from "@solana/web3.js";

import { SYMBOL_LEN, symbolBytes } from "./pda";

/** Ticker slots in the config (MAG7). */
export const TICKER_COUNT = 7;
/** Ticker slots one `initialize_config` / `update_config` call may carry. */
export const MAX_TICKER_SLOTS_PER_CALL = 6;
/** Oracle feeds per ticker: index 0 = Tiingo, index 1 = Twelve Data. */
export const FEEDS_PER_TICKER = 2;
/** Default `max_staleness_slots` (domain.md § Settlement rules). */
export const DEFAULT_MAX_STALENESS_SLOTS = 30n;
/** Default `max_conf_bps`. */
export const DEFAULT_MAX_CONF_BPS = 5;
/** Default `override_delay_secs`. */
export const DEFAULT_OVERRIDE_DELAY_SECS = 3_600n;

/** One ticker with its two feeds and pinned feed hashes. */
export type TickerInput = {
  readonly symbol: string;
  readonly feeds: readonly [PublicKey, PublicKey];
  readonly feedHashes: readonly [Uint8Array, Uint8Array];
};

/** A ticker and the config slot (0–6) it occupies. */
export type TickerSlotInput = { readonly index: number; readonly ticker: TickerInput };

/** Scalar config fields plus the ticker slots of one call. */
export type ConfigParamsInput = {
  readonly automationAuthority: PublicKey;
  readonly maxStalenessSlots: bigint;
  readonly maxConfBps: number;
  readonly overrideDelaySecs: bigint;
  readonly tickers: readonly TickerSlotInput[];
};

/** The `ConfigParams` argument as Anchor's TS client encodes it. */
export type ConfigParamsArg = {
  automationAuthority: PublicKey;
  maxStalenessSlots: BN;
  maxConfBps: number;
  overrideDelaySecs: BN;
  tickers: {
    index: number;
    ticker: { symbol: number[]; feeds: PublicKey[]; feedHashes: number[][] };
  }[];
};

function feedHash(bytes: Uint8Array): number[] {
  if (bytes.length !== 32) {
    throw new Error(`feed hash must be 32 bytes, got ${bytes.length}`);
  }
  return Array.from(bytes);
}

/** Encodes one ticker slot; throws on a bad slot index, symbol or hash length. */
export function tickerSlotArg(slot: TickerSlotInput): ConfigParamsArg["tickers"][number] {
  if (!Number.isInteger(slot.index) || slot.index < 0 || slot.index >= TICKER_COUNT) {
    throw new Error(`ticker slot index must be 0-${TICKER_COUNT - 1}: ${slot.index}`);
  }
  const symbol = Array.from(symbolBytes(slot.ticker.symbol));
  if (symbol.length !== SYMBOL_LEN) {
    throw new Error("unreachable: symbolBytes always returns 8 bytes");
  }
  return {
    index: slot.index,
    ticker: {
      symbol,
      feeds: [...slot.ticker.feeds],
      feedHashes: slot.ticker.feedHashes.map(feedHash),
    },
  };
}

/** Encodes `ConfigParams`; throws when more than six slots are given or any is invalid. */
export function configParamsArg(input: ConfigParamsInput): ConfigParamsArg {
  if (input.tickers.length > MAX_TICKER_SLOTS_PER_CALL) {
    throw new Error(
      `at most ${MAX_TICKER_SLOTS_PER_CALL} ticker slots fit in one call, got ${input.tickers.length}`,
    );
  }
  const indexes = new Set(input.tickers.map((slot) => slot.index));
  if (indexes.size !== input.tickers.length) {
    throw new Error("ticker slots must have distinct indexes");
  }
  if (input.maxStalenessSlots <= 0n) {
    throw new Error(`max_staleness_slots must be positive: ${input.maxStalenessSlots}`);
  }
  if (!Number.isInteger(input.maxConfBps) || input.maxConfBps < 1 || input.maxConfBps > 10_000) {
    throw new Error(`max_conf_bps must be an integer in 1-10000: ${input.maxConfBps}`);
  }
  if (input.overrideDelaySecs < 0n) {
    throw new Error(`override_delay_secs must not be negative: ${input.overrideDelaySecs}`);
  }
  return {
    automationAuthority: input.automationAuthority,
    maxStalenessSlots: new BN(input.maxStalenessSlots.toString()),
    maxConfBps: input.maxConfBps,
    overrideDelaySecs: new BN(input.overrideDelaySecs.toString()),
    tickers: input.tickers.map(tickerSlotArg),
  };
}

/**
 * Splits `tickers` (slot i = index i) into the parameter sets of consecutive calls: the first
 * for `initialize_config`, the rest for `update_config`. Each call repeats the scalar fields.
 */
export function configParamsBatches(
  scalars: Omit<ConfigParamsInput, "tickers">,
  tickers: readonly TickerInput[],
): ConfigParamsInput[] {
  if (tickers.length > TICKER_COUNT) {
    throw new Error(`at most ${TICKER_COUNT} tickers, got ${tickers.length}`);
  }
  const slots = tickers.map((ticker, index) => ({ index, ticker }));
  const batches: ConfigParamsInput[] = [];
  for (let start = 0; start < slots.length; start += MAX_TICKER_SLOTS_PER_CALL) {
    batches.push({ ...scalars, tickers: slots.slice(start, start + MAX_TICKER_SLOTS_PER_CALL) });
  }
  return batches.length === 0 ? [{ ...scalars, tickers: [] }] : batches;
}
