import {
  DEFAULT_MAX_CONF_BPS,
  DEFAULT_MAX_STALENESS_SLOTS,
  DEFAULT_OVERRIDE_DELAY_SECS,
  MAX_TICKER_SLOTS_PER_CALL,
  type ConfigParamsInput,
  type TickerSlotInput,
} from "@meridian/client";
import { PublicKey } from "@solana/web3.js";

import { bytesToHex, type FeedsByTicker, TICKER_ORDER } from "./feeds-file";

/** One ticker slot as stored in the Config account (an empty slot has an empty symbol). */
export type OnChainTicker = {
  readonly symbol: string;
  readonly feeds: readonly [PublicKey, PublicKey];
  readonly feedHashes: readonly [Uint8Array, Uint8Array];
};

/** The Config account, decoded. */
export type OnChainConfig = {
  readonly admin: PublicKey;
  readonly automationAuthority: PublicKey;
  readonly usdcMint: PublicKey;
  readonly maxStalenessSlots: bigint;
  readonly maxConfBps: number;
  readonly overrideDelaySecs: bigint;
  readonly tickers: readonly OnChainTicker[];
};

export type Desired = {
  readonly admin: PublicKey;
  readonly automationAuthority: PublicKey;
  readonly usdcMint: PublicKey;
  /** Real feeds from `--feeds`; when absent, existing feed fields are never touched. */
  readonly feeds?: FeedsByTicker | undefined;
};

export type ConfigStep = {
  readonly kind: "initialize_config" | "update_config";
  readonly params: ConfigParamsInput;
};

/** A feed slot with no feed: the default pubkey and a zero hash (docs/tickets/M2.md M2-01). */
export const PLACEHOLDER_PUBKEY = PublicKey.default;
export const PLACEHOLDER_HASH = new Uint8Array(32);

export class ConfigMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigMismatchError";
  }
}

function isPlaceholder(pubkey: PublicKey, hash: Uint8Array): boolean {
  return pubkey.equals(PLACEHOLDER_PUBKEY) && hash.every((byte) => byte === 0);
}

/** True when a feed slot still holds the placeholder. */
export function isPlaceholderPin(pin: { pubkey: PublicKey; hash: Uint8Array }): boolean {
  return isPlaceholder(pin.pubkey, pin.hash);
}

function slotFor(index: number, feeds: FeedsByTicker | undefined): TickerSlotInput {
  const symbol = TICKER_ORDER[index];
  if (symbol === undefined) {
    throw new Error(`no ticker for config slot ${index}`);
  }
  const pins = feeds?.get(symbol);
  const first = pins?.[0];
  const second = pins?.[1];
  return {
    index,
    ticker: {
      symbol,
      feeds: [first?.pubkey ?? PLACEHOLDER_PUBKEY, second?.pubkey ?? PLACEHOLDER_PUBKEY],
      feedHashes: [first?.hash ?? PLACEHOLDER_HASH, second?.hash ?? PLACEHOLDER_HASH],
    },
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function sameFeeds(onChain: OnChainTicker, slot: TickerSlotInput): boolean {
  return [0, 1].every((i) => {
    const feed = onChain.feeds[i];
    const hash = onChain.feedHashes[i];
    const wantFeed = slot.ticker.feeds[i];
    const wantHash = slot.ticker.feedHashes[i];
    return (
      feed !== undefined &&
      hash !== undefined &&
      wantFeed !== undefined &&
      wantHash !== undefined &&
      feed.equals(wantFeed) &&
      bytesToHex(hash) === bytesToHex(wantHash)
    );
  });
}

/**
 * The transactions that bring the Config account to `desired`; empty when it already is.
 *
 * - No Config yet: `initialize_config` with the defaults (staleness 30, conf 5 bps, override
 *   delay 3600) and the first six tickers, then `update_config` for the seventh. Feeds are
 *   placeholders unless `desired.feeds` is given.
 * - Config exists: its admin, automation authority and mint must equal `desired` (otherwise
 *   `ConfigMismatchError`; nothing is sent). Empty slots get placeholders (or the given feeds);
 *   with `desired.feeds`, slots whose feeds or hashes differ are replaced; at most six slots per
 *   call. Scalar fields are always resent from chain, because `update_config` overwrites them.
 *   Feeds already set are never replaced by placeholders.
 */
export function planConfig(onChain: OnChainConfig | null, desired: Desired): ConfigStep[] {
  if (onChain === null) {
    const scalars = {
      automationAuthority: desired.automationAuthority,
      maxStalenessSlots: DEFAULT_MAX_STALENESS_SLOTS,
      maxConfBps: DEFAULT_MAX_CONF_BPS,
      overrideDelaySecs: DEFAULT_OVERRIDE_DELAY_SECS,
    };
    const slots = TICKER_ORDER.map((_, index) => slotFor(index, desired.feeds));
    return chunk(slots, MAX_TICKER_SLOTS_PER_CALL).map((tickers, i) => ({
      kind: i === 0 ? "initialize_config" : "update_config",
      params: { ...scalars, tickers },
    }));
  }

  assertConfigMatches(onChain, desired);

  const changed: TickerSlotInput[] = [];
  TICKER_ORDER.forEach((symbol, index) => {
    const current = onChain.tickers[index];
    const slot = slotFor(index, desired.feeds);
    if (current === undefined || current.symbol === "") {
      changed.push(slot);
      return;
    }
    if (current.symbol !== symbol) {
      throw new ConfigMismatchError(
        `config slot ${index} holds ${current.symbol}, expected ${symbol}; nothing was sent`,
      );
    }
    if (desired.feeds !== undefined && !sameFeeds(current, slot)) {
      changed.push(slot);
    }
  });
  const scalars = {
    automationAuthority: onChain.automationAuthority,
    maxStalenessSlots: onChain.maxStalenessSlots,
    maxConfBps: onChain.maxConfBps,
    overrideDelaySecs: onChain.overrideDelaySecs,
  };
  return chunk(changed, MAX_TICKER_SLOTS_PER_CALL).map((tickers) => ({
    kind: "update_config" as const,
    params: { ...scalars, tickers },
  }));
}

/** Throws `ConfigMismatchError` unless admin, automation authority and mint match. */
export function assertConfigMatches(onChain: OnChainConfig, desired: Desired): void {
  const wrong: string[] = [];
  if (!onChain.admin.equals(desired.admin)) {
    wrong.push(`admin is ${onChain.admin.toBase58()}, expected ${desired.admin.toBase58()}`);
  }
  if (!onChain.automationAuthority.equals(desired.automationAuthority)) {
    wrong.push(
      `automation authority is ${onChain.automationAuthority.toBase58()}, expected ${desired.automationAuthority.toBase58()}`,
    );
  }
  if (!onChain.usdcMint.equals(desired.usdcMint)) {
    wrong.push(
      `USDC mint is ${onChain.usdcMint.toBase58()}, expected ${desired.usdcMint.toBase58()}`,
    );
  }
  if (wrong.length > 0) {
    throw new ConfigMismatchError(
      `the on-chain Config does not match this deployment (${wrong.join("; ")}); nothing was sent`,
    );
  }
}

/** Throws `ConfigMismatchError` unless the Config's admin is `admin`. Checked on every run. */
export function assertConfigAdmin(onChain: OnChainConfig, admin: PublicKey): void {
  if (!onChain.admin.equals(admin)) {
    throw new ConfigMismatchError(
      `the on-chain Config belongs to admin ${onChain.admin.toBase58()}, not ${admin.toBase58()}; nothing was sent. ` +
        "On a first run this means someone else won the initialize_config race: do not retry, " +
        "re-key the program per OQ-5 (new declare_id!).",
    );
  }
}
