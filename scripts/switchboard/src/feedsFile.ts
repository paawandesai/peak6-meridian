/**
 * The feeds file (`deployments/feeds.devnet.json`): public data only. It is what `create-feeds
 * --out` writes and what `scripts/deploy` takes as `--feeds` to replace the placeholder feeds in
 * Config: `{ "AAPL": [{pubkey, hash}, {pubkey, hash}], ... }` for all seven tickers, index 0 =
 * Tiingo, index 1 = Twelve Data, hash = 64 hex characters.
 */
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import type { CreatedFeed } from "./devnet";
import { SOURCES, TICKERS, type Ticker } from "./feeds";

export interface FeedPin {
  readonly pubkey: string;
  readonly hash: string;
}
export type FeedsFile = Readonly<Record<Ticker, readonly [FeedPin, FeedPin]>>;

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
const pin = z.strictObject({ pubkey, hash: z.string().regex(/^[0-9a-f]{64}$/) });
const pair = z.tuple([pin, pin]);
const fileSchema = z.strictObject(
  Object.fromEntries(TICKERS.map((ticker) => [ticker, pair])) as Record<Ticker, typeof pair>,
);

/** The feeds-file JSON for created feeds; every ticker needs both of its feeds. */
export function feedsFileJson(created: readonly CreatedFeed[]): string {
  const out: Record<string, FeedPin[]> = {};
  for (const ticker of TICKERS) {
    out[ticker] = SOURCES.map((source) => {
      const feed = created.find((c) => c.ticker === ticker && c.source === source);
      if (feed === undefined) {
        throw new Error(
          `no ${source} feed was created for ${ticker}; not writing a partial feeds file`,
        );
      }
      return { pubkey: feed.feed, hash: feed.feedHash };
    });
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Parses a feeds file; throws a readable error (no values echoed beyond the path). */
export function parseFeedsFile(text: string, label = "feeds file"): FeedsFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${label} is invalid at "${issue?.path.join(".") ?? ""}": ${issue?.message ?? "bad shape"}`,
    );
  }
  return parsed.data;
}
