import { MAX_TICKER_SLOTS_PER_CALL } from "@meridian/client";
import { Keypair, PublicKey } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertConfigAdmin,
  ConfigMismatchError,
  isPlaceholderPin,
  type OnChainConfig,
  type OnChainTicker,
  PLACEHOLDER_HASH,
  PLACEHOLDER_PUBKEY,
  planConfig,
} from "./config-plan";
import { bytesToHex, type FeedsByTicker, parseFeedsFile, TICKER_ORDER } from "./feeds-file";
import { feedsJson } from "./test-helpers";

const admin = Keypair.generate().publicKey;
const automation = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const desired = { admin, automationAuthority: automation, usdcMint: mint };

const placeholderTicker = (symbol: string): OnChainTicker => ({
  symbol,
  feeds: [PLACEHOLDER_PUBKEY, PLACEHOLDER_PUBKEY],
  feedHashes: [PLACEHOLDER_HASH, PLACEHOLDER_HASH],
});
const emptySlot = (): OnChainTicker => placeholderTicker("");

function onChain(tickers: OnChainTicker[], overrides: Partial<OnChainConfig> = {}): OnChainConfig {
  return {
    admin,
    automationAuthority: automation,
    usdcMint: mint,
    maxStalenessSlots: 30n,
    maxConfBps: 5,
    overrideDelaySecs: 3_600n,
    tickers,
    ...overrides,
  };
}

const allPlaceholders = () => TICKER_ORDER.map(placeholderTicker);
const feeds: FeedsByTicker = parseFeedsFile(JSON.stringify(feedsJson()));

function liveTickers(): OnChainTicker[] {
  return TICKER_ORDER.map((symbol) => {
    const pins = feeds.get(symbol);
    if (pins === undefined) throw new Error("fixture");
    return {
      symbol,
      feeds: [pins[0].pubkey, pins[1].pubkey],
      feedHashes: [pins[0].hash, pins[1].hash],
    };
  });
}

describe("planConfig without a Config", () => {
  it("initialises with the defaults and six tickers, then updates the seventh", () => {
    const steps = planConfig(null, desired);
    expect(steps.map((s) => s.kind)).toEqual(["initialize_config", "update_config"]);
    expect(steps[0]?.params.tickers).toHaveLength(MAX_TICKER_SLOTS_PER_CALL);
    expect(steps[1]?.params.tickers.map((t) => t.index)).toEqual([6]);
    const first = steps[0]?.params;
    expect(first?.maxStalenessSlots).toBe(30n);
    expect(first?.maxConfBps).toBe(5);
    expect(first?.overrideDelaySecs).toBe(3_600n);
    expect(first?.automationAuthority.equals(automation)).toBe(true);
  });

  it("uses placeholder feeds when no feeds file is given", () => {
    const slots = planConfig(null, desired).flatMap((s) => s.params.tickers);
    expect(slots).toHaveLength(7);
    for (const slot of slots) {
      expect(slot.ticker.feeds.every((f) => f.equals(PLACEHOLDER_PUBKEY))).toBe(true);
      expect(slot.ticker.feedHashes.every((h) => h.every((b) => b === 0))).toBe(true);
    }
  });

  it("pins the given feeds from the start when --feeds is given", () => {
    const slots = planConfig(null, { ...desired, feeds }).flatMap((s) => s.params.tickers);
    expect(slots.map((s) => s.ticker.symbol)).toEqual([...TICKER_ORDER]);
    expect(
      slots[0]?.ticker.feeds[0]?.equals(feeds.get("AAPL")?.[0].pubkey ?? PublicKey.default),
    ).toBe(true);
  });
});

describe("planConfig with a Config", () => {
  it("does nothing when all slots are populated and no feeds file is given", () => {
    expect(planConfig(onChain(allPlaceholders()), desired)).toEqual([]);
    expect(planConfig(onChain(liveTickers()), desired)).toEqual([]);
  });

  it("fills only the empty slot after a crash between initialize and the second call", () => {
    const tickers = [...allPlaceholders().slice(0, 6), emptySlot()];
    const steps = planConfig(onChain(tickers), desired);
    expect(steps.map((s) => s.kind)).toEqual(["update_config"]);
    expect(steps[0]?.params.tickers.map((t) => t.index)).toEqual([6]);
  });

  it("never sends placeholders over non-default feeds (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }), (live) => {
        const current = liveTickers();
        const tickers = TICKER_ORDER.map((_, i) =>
          live[i] === true ? (current[i] as OnChainTicker) : emptySlot(),
        );
        const steps = planConfig(onChain(tickers), desired);
        for (const slot of steps.flatMap((s) => s.params.tickers)) {
          // only empty slots may be written, and with placeholders
          expect(live[slot.index]).toBe(false);
        }
      }),
    );
  });

  it("replaces placeholders with real feeds in 6 + 1 update_config calls", () => {
    const steps = planConfig(onChain(allPlaceholders()), { ...desired, feeds });
    expect(steps.map((s) => s.kind)).toEqual(["update_config", "update_config"]);
    expect(steps.map((s) => s.params.tickers.length)).toEqual([6, 1]);
    for (const step of steps) {
      expect(step.params.tickers.length).toBeLessThanOrEqual(MAX_TICKER_SLOTS_PER_CALL);
    }
  });

  it("is a no-op when the same feeds are already pinned", () => {
    expect(planConfig(onChain(liveTickers()), { ...desired, feeds })).toEqual([]);
  });

  it("changes only the slots whose feeds differ", () => {
    const tickers = liveTickers();
    tickers[2] = placeholderTicker("GOOGL");
    const steps = planConfig(onChain(tickers), { ...desired, feeds });
    expect(steps.flatMap((s) => s.params.tickers.map((t) => t.index))).toEqual([2]);
  });

  it("resends the on-chain scalars, because update_config overwrites them", () => {
    const current = onChain(allPlaceholders(), {
      maxStalenessSlots: 77n,
      maxConfBps: 9,
      overrideDelaySecs: 1_234n,
    });
    const steps = planConfig(current, { ...desired, feeds });
    for (const step of steps) {
      expect(step.params.maxStalenessSlots).toBe(77n);
      expect(step.params.maxConfBps).toBe(9);
      expect(step.params.overrideDelaySecs).toBe(1_234n);
      expect(step.params.automationAuthority.equals(automation)).toBe(true);
    }
  });

  it("fails loudly on another admin, another automation authority or another mint", () => {
    const other = Keypair.generate().publicKey;
    expect(() => planConfig(onChain(allPlaceholders(), { admin: other }), desired)).toThrow(
      ConfigMismatchError,
    );
    expect(() =>
      planConfig(onChain(allPlaceholders(), { automationAuthority: other }), desired),
    ).toThrow(/automation authority/);
    expect(() => planConfig(onChain(allPlaceholders(), { usdcMint: other }), desired)).toThrow(
      /USDC mint/,
    );
    expect(() => assertConfigAdmin(onChain([], { admin: other }), admin)).toThrow(/not /);
    expect(() => assertConfigAdmin(onChain([]), admin)).not.toThrow();
  });

  it("fails when a populated slot holds the wrong ticker", () => {
    const tickers = allPlaceholders();
    tickers[0] = placeholderTicker("MSFT");
    expect(() => planConfig(onChain(tickers), desired)).toThrow(/slot 0 holds MSFT/);
  });
});

describe("isPlaceholderPin", () => {
  it("is true only for the default pubkey with a zero hash", () => {
    expect(isPlaceholderPin({ pubkey: PLACEHOLDER_PUBKEY, hash: PLACEHOLDER_HASH })).toBe(true);
    expect(isPlaceholderPin({ pubkey: Keypair.generate().publicKey, hash: PLACEHOLDER_HASH })).toBe(
      false,
    );
    const hash = new Uint8Array(32);
    hash[3] = 1;
    expect(isPlaceholderPin({ pubkey: PLACEHOLDER_PUBKEY, hash })).toBe(false);
    expect(bytesToHex(hash)).toHaveLength(64);
  });
});
