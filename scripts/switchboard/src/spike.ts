import { FeedHash, OracleJob } from "@switchboard-xyz/common";
import type { PublicKey } from "@solana/web3.js";

import { formatScaled18, median, spreadCentiBps, toScaled18, withinSpread } from "./decimal";
import { TICKERS, type FeedDefinition, type Source, type Ticker } from "./feeds";

/** domain.md § Settlement rules, `max_conf_bps` default. */
export const MAX_CONF_BPS = 5n;

/** One oracle's answer for one feed update. Values are decimal text; errors are oracle text. */
export interface OracleResult {
  readonly oracle: string;
  readonly value: string | null;
  readonly error: string | null;
}

/** A simulated feed update: the feed account (null if not created), slot and oracle answers. */
export interface FeedUpdate {
  readonly feed: string | null;
  readonly slot: number;
  readonly oracles: readonly OracleResult[];
}

/** Produces a feed update for a definition: fixtures in dry-run, Switchboard on devnet. */
export interface UpdateSimulator {
  simulate(def: FeedDefinition, feedHash: string): Promise<FeedUpdate>;
}

export interface FeedReport {
  readonly ticker: Ticker;
  readonly source: Source;
  readonly name: string;
  readonly feed: string | null;
  readonly feedHash: string;
  /** Median of the successful oracle values, or null if none succeeded. */
  readonly value: string | null;
  readonly slot: number | null;
  readonly oracles: readonly OracleResult[];
  readonly error: string | null;
}

export interface TickerCheck {
  readonly ticker: Ticker;
  /** Spread between the two sources in basis points of their mean, or null if one is missing. */
  readonly spreadBps: string | null;
  readonly withinMaxSpread: boolean;
}

export interface SpikeReport {
  readonly mode: "dry-run" | "devnet";
  readonly queue: string;
  readonly feeds: readonly FeedReport[];
  readonly tickers: readonly TickerCheck[];
  /** True when every feed produced a value and every ticker's two sources agree. */
  readonly ok: boolean;
}

/** The definition's jobs as Switchboard OracleJob messages. */
export function toOracleJobs(def: FeedDefinition): OracleJob[] {
  return def.jobs.map((job) => OracleJob.fromObject(job));
}

/** Feed hash (hex, no 0x) = sha256(queue ‖ serialized jobs); the value pinned in Config. */
export function computeFeedHash(queue: PublicKey, def: FeedDefinition): string {
  return FeedHash.compute(queue.toBuffer(), toOracleJobs(def)).toString("hex");
}

/** Simulate one update per definition and check each ticker's two sources against each other. */
export async function runSpike(params: {
  readonly mode: SpikeReport["mode"];
  readonly queue: PublicKey;
  readonly defs: readonly FeedDefinition[];
  readonly simulator: UpdateSimulator;
}): Promise<SpikeReport> {
  const feeds: FeedReport[] = [];
  for (const def of params.defs) {
    feeds.push(await reportFeed(def, computeFeedHash(params.queue, def), params.simulator));
  }
  const tickers = TICKERS.filter((ticker) => feeds.some((f) => f.ticker === ticker)).map((ticker) =>
    checkTicker(ticker, feeds),
  );
  const ok = feeds.every((f) => f.value !== null) && tickers.every((t) => t.withinMaxSpread);
  return { mode: params.mode, queue: params.queue.toBase58(), feeds, tickers, ok };
}

async function reportFeed(
  def: FeedDefinition,
  feedHash: string,
  simulator: UpdateSimulator,
): Promise<FeedReport> {
  const base = { ticker: def.ticker, source: def.source, name: def.name, feedHash };
  try {
    const update = await simulator.simulate(def, feedHash);
    const values = update.oracles
      .filter((o) => o.error === null && o.value !== null)
      .map((o) => toScaled18(o.value ?? ""));
    const value = values.length > 0 ? formatScaled18(median(values)) : null;
    const error = value === null ? "no oracle returned a value" : null;
    return { ...base, feed: update.feed, value, slot: update.slot, oracles: update.oracles, error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, feed: null, value: null, slot: null, oracles: [], error: message };
  }
}

function checkTicker(ticker: Ticker, feeds: readonly FeedReport[]): TickerCheck {
  const values = feeds
    .filter((f) => f.ticker === ticker && f.value !== null)
    .map((f) => toScaled18(f.value ?? ""));
  const [a, b] = values;
  if (values.length !== 2 || a === undefined || b === undefined || a <= 0n || b <= 0n) {
    return { ticker, spreadBps: null, withinMaxSpread: false };
  }
  const centiBps = spreadCentiBps(a, b);
  const spreadBps = `${centiBps / 100n}.${(centiBps % 100n).toString().padStart(2, "0")}`;
  return { ticker, spreadBps, withinMaxSpread: withinSpread(a, b, MAX_CONF_BPS) };
}
