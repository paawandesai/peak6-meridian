// Builds tests/fixtures/deploy/feeds.fixture.json: seven tickers x two feeds with deterministic
// public keys and the feed hashes computed from oracle/feeds/* for FIXTURE_QUEUE. Public data
// only: the keypairs behind these addresses are derived from seeds and discarded here.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair, PublicKey } from "@solana/web3.js";
import { computeFeedHash, loadFeedDefinitions } from "switchboard-scripts";

import { SOURCE_ORDER, TICKER_ORDER } from "../lib/feeds-file";

/** A made-up Switchboard queue used only to compute fixture feed hashes. */
export const FIXTURE_QUEUE = new PublicKey(Buffer.alloc(32, 7));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const FEEDS_FIXTURE_PATH = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "deploy",
  "feeds.fixture.json",
);

export type FeedsFixture = Record<string, { pubkey: string; hash: string }[]>;

/** The fixture content: stable across runs and machines. */
export function buildFeedsFixture(repoRoot: string = REPO_ROOT): FeedsFixture {
  const defs = loadFeedDefinitions(join(repoRoot, "oracle", "feeds"));
  const out: FeedsFixture = {};
  for (const ticker of TICKER_ORDER) {
    out[ticker] = SOURCE_ORDER.map((source) => {
      const def = defs.find((d) => d.ticker === ticker && d.source === source);
      if (def === undefined) {
        throw new Error(`no feed definition for ${ticker}.${source}`);
      }
      const seed = createHash("sha256")
        .update(`meridian-deploy-fixture:${ticker}:${source}`)
        .digest();
      return {
        pubkey: Keypair.fromSeed(seed).publicKey.toBase58(),
        hash: computeFeedHash(FIXTURE_QUEUE, def),
      };
    });
  }
  return out;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(FEEDS_FIXTURE_PATH, `${JSON.stringify(buildFeedsFixture(), null, 2)}\n`);
  process.stdout.write(`wrote ${FEEDS_FIXTURE_PATH}\n`);
}
