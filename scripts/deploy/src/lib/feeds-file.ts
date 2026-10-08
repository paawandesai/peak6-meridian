import { readFileSync } from "node:fs";

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

/** Tickers in config-slot order (docs/domain.md § Glossary). */
export const TICKER_ORDER = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
export type TickerSymbol = (typeof TICKER_ORDER)[number];
/** Sources in feed-slot order: index 0 = Tiingo, index 1 = Twelve Data. */
export const SOURCE_ORDER = ["tiingo", "twelvedata"] as const;

/** One pinned feed: its account and its 32-byte hash. */
export type FeedPin = { readonly pubkey: PublicKey; readonly hash: Uint8Array };
export type TickerFeeds = readonly [FeedPin, FeedPin];
export type FeedsByTicker = ReadonlyMap<TickerSymbol, TickerFeeds>;

const hashHex = z.string().regex(/^[0-9a-fA-F]{64}$/, "feed hash must be 64 hex characters");
const pubkey = z.string().refine(
  (value) => {
    try {
      new PublicKey(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "not a base58 public key" },
);
const feedEntry = z.strictObject({ pubkey, hash: hashHex });
const pair = z.tuple([feedEntry, feedEntry]);

/** The `--feeds` file: seven tickers, each with a Tiingo and a Twelve Data feed. */
export const feedsFileSchema = z.strictObject(
  Object.fromEntries(TICKER_ORDER.map((ticker) => [ticker, pair])) as Record<
    TickerSymbol,
    typeof pair
  >,
);

export function hexToBytes(hex: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error("not a hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parses the text of a `--feeds` file; throws a readable error on any problem. */
export function parseFeedsFile(text: string, label = "feeds file"): FeedsByTicker {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  const parsed = feedsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join(".") : "";
    throw new Error(`${label} is invalid at "${where}": ${issue?.message ?? "bad shape"}`);
  }
  const out = new Map<TickerSymbol, TickerFeeds>();
  for (const ticker of TICKER_ORDER) {
    const [a, b] = parsed.data[ticker];
    out.set(ticker, [
      { pubkey: new PublicKey(a.pubkey), hash: hexToBytes(a.hash) },
      { pubkey: new PublicKey(b.pubkey), hash: hexToBytes(b.hash) },
    ]);
  }
  const seen = new Set<string>();
  for (const feeds of out.values()) {
    for (const feed of feeds) {
      const key = feed.pubkey.toBase58();
      if (seen.has(key)) {
        throw new Error(`${label} lists the feed account ${key} more than once`);
      }
      seen.add(key);
    }
  }
  return out;
}

export function readFeedsFile(path: string): FeedsByTicker {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read the feeds file ${path}`);
  }
  return parseFeedsFile(text, path);
}

/**
 * Checks every hash against the hash computed from `oracle/feeds/*` for the same ticker and
 * source (`expected(ticker, sourceIndex)`, hex). Throws naming each mismatching feed.
 */
export function assertHashesMatchDefinitions(
  feeds: FeedsByTicker,
  expected: (ticker: TickerSymbol, sourceIndex: 0 | 1) => string,
): void {
  const problems: string[] = [];
  for (const ticker of TICKER_ORDER) {
    const pins = feeds.get(ticker);
    if (pins === undefined) {
      problems.push(`${ticker}: missing`);
      continue;
    }
    for (const index of [0, 1] as const) {
      const pin = pins[index];
      const want = expected(ticker, index).toLowerCase();
      if (bytesToHex(pin.hash) !== want) {
        problems.push(`${ticker}.${SOURCE_ORDER[index]}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `feed hash differs from oracle/feeds/* for: ${problems.join(", ")}. Nothing was sent.`,
    );
  }
}
