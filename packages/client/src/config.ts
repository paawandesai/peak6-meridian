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
/** Default `pyth_max_age_secs` (D-055, M3-10b): the on-chain rule requires it to be positive. */
export const DEFAULT_PYTH_MAX_AGE_SECS = 30n;
/** Largest Pyth Pro numeric feed id (`u32`). */
const MAX_U32 = 0xffff_ffff;
/** Largest `i64`. */
const MAX_I64 = (1n << 63n) - 1n;

/** One ticker with its two feeds and pinned feed hashes. */
export type TickerInput = {
  readonly symbol: string;
  readonly feeds: readonly [PublicKey, PublicKey];
  readonly feedHashes: readonly [Uint8Array, Uint8Array];
};

/** A ticker and the config slot (0–6) it occupies. */
export type TickerSlotInput = { readonly index: number; readonly ticker: TickerInput };

/**
 * The Pyth Lazer settlement fields of the Config (D-055, M3-10b): the pinned Ed25519 signer, the
 * numeric Pyth Pro feed id per ticker slot (0 = no Pyth feed for that slot) and the maximum age
 * of a Pyth price at settlement. `update_config` overwrites them on every call, so callers that
 * only change other fields pass the on-chain values through (`pythConfigFromAccount`).
 */
export type PythConfigInput = {
  readonly lazerSigner: PublicKey;
  readonly feedIds: readonly number[];
  readonly maxAgeSecs: bigint;
};

/** No Pyth signer and no feeds: the Pyth settlement path stays off until the admin sets them. */
export const PYTH_DISABLED: PythConfigInput = Object.freeze({
  lazerSigner: PublicKey.default,
  feedIds: Object.freeze(new Array<number>(TICKER_COUNT).fill(0)),
  maxAgeSecs: DEFAULT_PYTH_MAX_AGE_SECS,
});

/** Scalar config fields plus the ticker slots of one call. */
export type ConfigParamsInput = {
  readonly automationAuthority: PublicKey;
  readonly maxStalenessSlots: bigint;
  readonly maxConfBps: number;
  readonly overrideDelaySecs: bigint;
  readonly tickers: readonly TickerSlotInput[];
  readonly pyth: PythConfigInput;
};

/** The Pyth fields as Anchor's TS client encodes them (`PythConfigParams` / `ConfigParams`). */
export type PythConfigArg = {
  pythLazerSigner: PublicKey;
  pythFeedIds: number[];
  pythMaxAgeSecs: BN;
};

/** The `ConfigParams` argument as Anchor's TS client encodes it. */
export type ConfigParamsArg = PythConfigArg & {
  automationAuthority: PublicKey;
  maxStalenessSlots: BN;
  maxConfBps: number;
  overrideDelaySecs: BN;
  tickers: {
    index: number;
    ticker: { symbol: number[]; feeds: PublicKey[]; feedHashes: number[][] };
  }[];
};

/**
 * Encodes the Pyth fields for `initialize_config` / `update_config` (inside `ConfigParams`) or
 * `migrate_config` (`PythConfigParams`); throws on a wrong feed-id count, a feed id outside u32
 * or a max age that is not a positive i64 (MeridianError::InvalidPythMaxAge on chain).
 */
export function pythConfigArg(input: PythConfigInput): PythConfigArg {
  if (input.feedIds.length !== TICKER_COUNT) {
    throw new Error(`pyth feed ids must list ${TICKER_COUNT} slots, got ${input.feedIds.length}`);
  }
  for (const id of input.feedIds) {
    if (!Number.isInteger(id) || id < 0 || id > MAX_U32) {
      throw new Error(`pyth feed id must be a u32: ${id}`);
    }
  }
  if (input.maxAgeSecs <= 0n || input.maxAgeSecs > MAX_I64) {
    throw new Error(`pyth_max_age_secs must be a positive i64: ${input.maxAgeSecs}`);
  }
  return {
    pythLazerSigner: input.lazerSigner,
    pythFeedIds: [...input.feedIds],
    pythMaxAgeSecs: new BN(input.maxAgeSecs.toString()),
  };
}

/** The Pyth fields of a decoded Config account, as Anchor's TS client returns them. */
export type PythConfigAccount = {
  readonly pythLazerSigner: PublicKey;
  readonly pythFeedIds: readonly number[];
  readonly pythMaxAgeSecs: { toString(): string };
};

/**
 * The on-chain Pyth fields, to pass through an `update_config` that changes something else.
 * A zero max age (a Config migrated without Pyth parameters) becomes the default, because
 * `update_config` rejects zero; signer and feed ids are kept as they are.
 */
export function pythConfigFromAccount(account: PythConfigAccount): PythConfigInput {
  const maxAgeSecs = BigInt(account.pythMaxAgeSecs.toString());
  return {
    lazerSigner: account.pythLazerSigner,
    feedIds: [...account.pythFeedIds],
    maxAgeSecs: maxAgeSecs > 0n ? maxAgeSecs : DEFAULT_PYTH_MAX_AGE_SECS,
  };
}

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
    ...pythConfigArg(input.pyth),
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
