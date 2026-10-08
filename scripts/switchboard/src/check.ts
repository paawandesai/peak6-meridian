/**
 * `check-feeds` (M2-02): are the 14 feeds what the repository and the on-chain Config say they
 * are, and do the two sources of every ticker agree?
 *
 * Offline-testable: the oracle simulation (`UpdateSimulator`), the feed accounts
 * (`feedHashOf`) and the Config (`ConfigReader`) are injected. Every failure names its ticker.
 */
import { PublicKey } from "@solana/web3.js";

import { SOURCES, TICKERS, type FeedDefinition, type Ticker } from "./feeds";
import type { FeedsFile } from "./feedsFile";
import {
  MAX_CONF_BPS,
  computeFeedHash,
  runSpike,
  type SpikeReport,
  type UpdateSimulator,
} from "./spike";

/** The feed pinned in Config for a ticker and source slot, or null when none is. */
export interface ConfigReader {
  feed(
    ticker: Ticker,
    slot: number,
  ): Promise<{ readonly pubkey: string; readonly hash: string } | null>;
}

/** The feed hash stored in a PullFeed account; rejects when the account is missing or not a feed. */
export interface FeedAccounts {
  feedHashOf(feed: PublicKey): Promise<string>;
}

export interface FeedCheck {
  readonly ticker: Ticker;
  readonly source: (typeof SOURCES)[number];
  readonly feed: string | null;
  /** sha256(queue ‖ jobs) of the definition in `oracle/feeds`. */
  readonly expectedHash: string;
  readonly fileMatches: boolean | null;
  readonly accountMatches: boolean | null;
  readonly configMatches: boolean | null;
}

export interface CheckReport {
  readonly mode: SpikeReport["mode"];
  readonly queue: string;
  readonly ok: boolean;
  /** One line per problem, each starting with the ticker. */
  readonly failures: readonly string[];
  readonly feeds: readonly FeedCheck[];
  readonly simulation: SpikeReport;
}

export async function checkFeeds(params: {
  readonly mode: SpikeReport["mode"];
  readonly queue: PublicKey;
  readonly defs: readonly FeedDefinition[];
  readonly simulator: UpdateSimulator;
  /** Absent in an offline dry run: then only the simulation is checked. */
  readonly file?: FeedsFile | undefined;
  readonly accounts?: FeedAccounts | undefined;
  readonly config?: ConfigReader | undefined;
}): Promise<CheckReport> {
  const failures: string[] = [];
  const feeds: FeedCheck[] = [];

  for (const def of params.defs) {
    const slot = SOURCES.indexOf(def.source);
    const expectedHash = computeFeedHash(params.queue, def);
    const pin = params.file?.[def.ticker][slot];
    const label = `${def.ticker} ${def.source}`;

    let fileMatches: boolean | null = null;
    if (pin !== undefined) {
      fileMatches = pin.hash === expectedHash;
      if (!fileMatches) {
        failures.push(`${label}: the feeds file hash differs from the oracle/feeds definition`);
      }
    }

    let accountMatches: boolean | null = null;
    if (pin !== undefined && params.accounts !== undefined) {
      try {
        accountMatches =
          (await params.accounts.feedHashOf(new PublicKey(pin.pubkey))) === expectedHash;
        if (!accountMatches) {
          failures.push(
            `${label}: the feed account's hash differs from the oracle/feeds definition`,
          );
        }
      } catch {
        accountMatches = false;
        failures.push(`${label}: the feed account does not exist or is not a Switchboard feed`);
      }
    }

    let configMatches: boolean | null = null;
    if (pin !== undefined && params.config !== undefined) {
      const pinned = await params.config.feed(def.ticker, slot);
      configMatches =
        pinned !== null && pinned.pubkey === pin.pubkey && pinned.hash === expectedHash;
      if (!configMatches) {
        failures.push(
          `${label}: Config does not pin this feed and hash (re-run the deploy script with --feeds)`,
        );
      }
    }

    feeds.push({
      ticker: def.ticker,
      source: def.source,
      feed: pin?.pubkey ?? null,
      expectedHash,
      fileMatches,
      accountMatches,
      configMatches,
    });
  }

  const simulation = await runSpike({
    mode: params.mode,
    queue: params.queue,
    defs: params.defs,
    simulator: params.simulator,
  });
  for (const feed of simulation.feeds) {
    if (feed.value === null) {
      failures.push(
        `${feed.ticker} ${feed.source}: no value from the oracles (${feed.error ?? "unknown"})`,
      );
    }
  }
  for (const ticker of TICKERS) {
    const check = simulation.tickers.find((t) => t.ticker === ticker);
    if (check === undefined || check.withinMaxSpread) {
      continue;
    }
    failures.push(
      check.spreadBps === null
        ? `${ticker}: a source returned no value, so the spread cannot be checked`
        : `${ticker}: the two sources differ by ${check.spreadBps} bps of their mean (max ${String(MAX_CONF_BPS)} bps = 0.05%)`,
    );
  }

  return {
    mode: params.mode,
    queue: params.queue.toBase58(),
    ok: failures.length === 0,
    failures,
    feeds,
    simulation,
  };
}

interface ConfigAccount {
  readonly tickers: readonly {
    readonly symbol: readonly number[];
    readonly feeds: readonly PublicKey[];
    readonly feedHashes: readonly (readonly number[])[];
  }[];
}

/** Reads the pinned feeds from the Config account (a read-only anchor program). */
export function configReaderFromProgram(
  program: { account: { config: { fetch(address: PublicKey): Promise<unknown> } } },
  config: PublicKey,
): ConfigReader {
  let cached: Promise<ConfigAccount> | undefined;
  return {
    async feed(ticker, slot) {
      cached ??= program.account.config.fetch(config) as Promise<ConfigAccount>;
      const account = await cached;
      const entry = account.tickers.find(
        (t) => String.fromCharCode(...t.symbol.filter((byte) => byte !== 0)) === ticker,
      );
      const pubkey = entry?.feeds[slot];
      const hash = entry?.feedHashes[slot];
      if (pubkey === undefined || hash === undefined) {
        return null;
      }
      return { pubkey: pubkey.toBase58(), hash: Buffer.from(hash).toString("hex") };
    },
  };
}
