import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { checkFeeds, configReaderFromProgram, type ConfigReader, type FeedAccounts } from "./check";
import { DEFAULT_FEEDS_DIR, DEFAULT_FIXTURE } from "./cli";
import { DEVNET_QUEUE } from "./devnet";
import { SOURCES, TICKERS, loadFeedDefinitions } from "./feeds";
import type { FeedsFile } from "./feedsFile";
import { fixtureSimulator, loadFixture } from "./fixtures";
import { computeFeedHash } from "./spike";

const defs = loadFeedDefinitions(DEFAULT_FEEDS_DIR);
const simulator = fixtureSimulator(loadFixture(DEFAULT_FIXTURE));
const hashOf = (ticker: string, source: string): string => {
  const def = defs.find((d) => d.ticker === ticker && d.source === source);
  if (def === undefined) throw new Error("no def");
  return computeFeedHash(DEVNET_QUEUE, def);
};

/** A consistent world: the file, the accounts and Config all agree with oracle/feeds. */
function world() {
  const file = Object.fromEntries(
    TICKERS.map((ticker) => [
      ticker,
      SOURCES.map((source) => ({
        pubkey: Keypair.generate().publicKey.toBase58(),
        hash: hashOf(ticker, source),
      })),
    ]),
  ) as unknown as Record<string, { pubkey: string; hash: string }[]>;
  const accountHash = new Map<string, string>();
  for (const pins of Object.values(file))
    for (const pin of pins) accountHash.set(pin.pubkey, pin.hash);
  const accounts: FeedAccounts = {
    feedHashOf: (feed) => {
      const hash = accountHash.get(feed.toBase58());
      return hash === undefined ? Promise.reject(new Error("no account")) : Promise.resolve(hash);
    },
  };
  const config: ConfigReader = {
    feed: (ticker, slot) => Promise.resolve(file[ticker]?.[slot] ?? null),
  };
  return { file: file as unknown as FeedsFile, accountHash, accounts, config, raw: file };
}

/** The pinned feed of a ticker and slot in a test world; throws when the test names a bad one. */
function pinOf(
  w: ReturnType<typeof world>,
  ticker: string,
  slot: number,
): { pubkey: string; hash: string } {
  const pin = w.raw[ticker]?.[slot];
  if (pin === undefined) {
    throw new Error(`no pin for ${ticker} slot ${String(slot)}`);
  }
  return pin;
}

const run = (
  w: ReturnType<typeof world>,
  overrides: Partial<Parameters<typeof checkFeeds>[0]> = {},
) =>
  checkFeeds({
    mode: "devnet",
    queue: DEVNET_QUEUE,
    defs,
    simulator,
    file: w.file,
    accounts: w.accounts,
    config: w.config,
    ...overrides,
  });

describe("checkFeeds (AC1: the 14 feeds are what the repo and Config say)", () => {
  it("is ok when file, accounts and Config all match oracle/feeds and the sources agree", async () => {
    const report = await run(world());
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.feeds).toHaveLength(14);
    expect(report.feeds.every((f) => f.fileMatches && f.accountMatches && f.configMatches)).toBe(
      true,
    );
    expect(report.simulation.feeds.every((f) => f.value !== null)).toBe(true);
  });

  it("names the ticker when the feeds file hash differs from the definition", async () => {
    const w = world();
    const nvda = pinOf(w, "NVDA", 0);
    (w.raw["NVDA"] as { pubkey: string; hash: string }[])[0] = { ...nvda, hash: "0".repeat(64) };
    const report = await run(w);
    expect(report.ok).toBe(false);
    expect(report.failures).toContain(
      "NVDA tiingo: the feeds file hash differs from the oracle/feeds definition",
    );
  });

  it("names the ticker when a feed account is missing or holds another hash", async () => {
    const w = world();
    w.accountHash.delete(pinOf(w, "AAPL", 1).pubkey);
    w.accountHash.set(pinOf(w, "TSLA", 0).pubkey, "f".repeat(64));
    const report = await run(w);
    expect(report.failures).toContain(
      "AAPL twelvedata: the feed account does not exist or is not a Switchboard feed",
    );
    expect(report.failures).toContain(
      "TSLA tiingo: the feed account's hash differs from the oracle/feeds definition",
    );
  });

  it("names the ticker when Config still holds a placeholder (the deploy --feeds re-run is missing)", async () => {
    const w = world();
    const config: ConfigReader = {
      feed: (ticker, slot) =>
        ticker === "META"
          ? Promise.resolve({ pubkey: "11111111111111111111111111111111", hash: "0".repeat(64) })
          : w.config.feed(ticker, slot),
    };
    const report = await run(w, { config });
    expect(report.failures.filter((f) => f.startsWith("META "))).toHaveLength(2);
    expect(report.failures[0]).toMatch(/re-run the deploy script with --feeds/);
    const noConfig = await run(w, { config: { feed: () => Promise.resolve(null) } });
    expect(noConfig.ok).toBe(false);
  });

  it("without a feeds file, accounts or Config (an offline dry run) only the simulation is checked", async () => {
    const report = await checkFeeds({ mode: "dry-run", queue: DEVNET_QUEUE, defs, simulator });
    expect(report.ok).toBe(true);
    expect(
      report.feeds.every(
        (f) => f.fileMatches === null && f.accountMatches === null && f.configMatches === null,
      ),
    ).toBe(true);
  });
});

describe("checkFeeds: simulation failures name the ticker (AC2)", () => {
  it("a ticker whose sources differ by more than 5 bps fails with the spread", async () => {
    const w = world();
    const skewed = {
      simulate: async (def: (typeof defs)[number], hash: string) => {
        const update = await simulator.simulate(def, hash);
        if (def.ticker !== "MSFT" || def.source !== "twelvedata") return update;
        return {
          ...update,
          oracles: update.oracles.map((o) => ({
            ...o,
            value: o.value === null ? null : String(Number(o.value) * 1.001),
          })),
        };
      },
    };
    const report = await run(w, { simulator: skewed });
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(
      /^MSFT: the two sources differ by \d+\.\d+ bps of their mean \(max 5 bps = 0\.05%\)$/,
    );
  });

  it("a feed that returns no value fails, naming ticker and source", async () => {
    const w = world();
    const silent = {
      simulate: async (def: (typeof defs)[number], hash: string) => {
        const update = await simulator.simulate(def, hash);
        return def.ticker === "GOOGL" && def.source === "tiingo"
          ? {
              ...update,
              oracles: update.oracles.map((o) => ({ ...o, value: null, error: "job failed" })),
            }
          : update;
      },
    };
    const report = await run(w, { simulator: silent });
    expect(report.failures).toContain(
      "GOOGL tiingo: no value from the oracles (no oracle returned a value)",
    );
    expect(report.failures).toContain(
      "GOOGL: a source returned no value, so the spread cannot be checked",
    );
  });
});

describe("configReaderFromProgram", () => {
  const symbol = (text: string) => [
    ...Array.from(new TextEncoder().encode(text)),
    ...Array(8 - text.length).fill(0),
  ];
  const feeds = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const program = {
    account: {
      config: {
        fetch: () =>
          Promise.resolve({
            tickers: [
              { symbol: symbol("META"), feeds, feedHashes: [Array(32).fill(1), Array(32).fill(2)] },
              {
                symbol: Array(8).fill(0),
                feeds,
                feedHashes: [Array(32).fill(0), Array(32).fill(0)],
              },
            ],
          }),
      },
    },
  };

  it("returns the pinned feed and hash per ticker and slot, and null for an unconfigured ticker", async () => {
    const reader = configReaderFromProgram(program, Keypair.generate().publicKey);
    expect(await reader.feed("META", 1)).toEqual({
      pubkey: feeds[1]?.toBase58(),
      hash: "02".repeat(32),
    });
    expect(await reader.feed("AAPL", 0)).toBeNull();
  });
});
