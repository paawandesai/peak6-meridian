import { Keypair, type PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_FEEDS_DIR } from "./cli";
import {
  DEVNET_GENESIS_HASH,
  DEVNET_QUEUE,
  assertDevnet,
  createFeeds,
  feedAccountsJson,
  liveSimulator,
  parseFeedAccounts,
  redact,
  type SwitchboardClient,
} from "./devnet";
import { loadFeedDefinitions, type FeedDefinition } from "./feeds";
import { computeFeedHash } from "./spike";
import { fakeClient } from "./test-fakes";

const defs = loadFeedDefinitions(DEFAULT_FEEDS_DIR);
const aaplTiingo = defs[0] as FeedDefinition;
const pk = (): PublicKey => Keypair.generate().publicKey;
const SECRET = "s3cr3t-value-for-test";
const fake = (overrides: Partial<SwitchboardClient> = {}) => fakeClient(overrides, aaplTiingo);

describe("assertDevnet", () => {
  it("accepts devnet and refuses any other genesis (mainnet, localnet)", async () => {
    const conn = (hash: string) => ({ getGenesisHash: () => Promise.resolve(hash) });
    await expect(assertDevnet(conn(DEVNET_GENESIS_HASH))).resolves.toBeUndefined();
    await expect(
      assertDevnet(conn("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")),
    ).rejects.toThrow(/not Solana devnet/);
  });
});

describe("parseFeedAccounts", () => {
  it("parses ticker → [tiingo feed, twelvedata feed]", () => {
    const [a, b] = [pk(), pk()];
    const parsed = parseFeedAccounts(JSON.stringify({ AAPL: [a.toBase58(), b.toBase58()] }));
    expect(parsed.AAPL?.map((k) => k.toBase58())).toEqual([a.toBase58(), b.toBase58()]);
  });

  it.each([undefined, " ", '{"IBM":["a","b"]}', '{"AAPL":["only-one"]}'])("rejects %j", (json) => {
    expect(() => parseFeedAccounts(json)).toThrow(/SWITCHBOARD_FEEDS_JSON/);
  });

  it("rejects an invalid public key", () => {
    expect(() => parseFeedAccounts('{"AAPL":["not-a-key","x"]}')).toThrow();
  });
});

describe("redact", () => {
  it("removes every secret occurrence", () => {
    expect(redact(`401 for Token ${SECRET}; again ${SECRET}`, [SECRET, ""])).toBe(
      "401 for Token [redacted]; again [redacted]",
    );
  });
});

describe("liveSimulator", () => {
  const feed = pk();
  const feeds = { AAPL: [feed, pk()] };
  const variableOverrides = { TIINGO_API_KEY: SECRET, TWELVEDATA_API_KEY: "other" };
  const hash = computeFeedHash(DEVNET_QUEUE, aaplTiingo);

  it("fetches an update with the keys as overrides and simulates it", async () => {
    let seen: Record<string, string> = {};
    const client = fake({
      fetchUpdate: (_, overrides) => {
        seen = overrides;
        return Promise.resolve({ ixs: [], luts: [], oracles: [] });
      },
    });
    const update = await liveSimulator({ client, feeds, variableOverrides }).simulate(
      aaplTiingo,
      hash,
    );
    expect(update).toEqual({ feed: feed.toBase58(), slot: 99, oracles: [] });
    expect(seen).toEqual(variableOverrides);
  });

  it("refuses a feed account whose on-chain hash differs from the definition (AB-04)", async () => {
    const client = fake({ feedHashOf: () => Promise.resolve("ff".repeat(32)) });
    await expect(
      liveSimulator({ client, feeds, variableOverrides }).simulate(aaplTiingo, hash),
    ).rejects.toThrow(/has hash ff/);
  });

  it("fails when the ticker has no feed account", async () => {
    await expect(
      liveSimulator({ client: fake(), feeds: {}, variableOverrides }).simulate(aaplTiingo, hash),
    ).rejects.toThrow(/no feed account for AAPL\/tiingo/);
  });

  it("redacts keys echoed in oracle errors when no oracle signs", async () => {
    const client = fake({
      fetchUpdate: () =>
        Promise.resolve({
          ixs: undefined,
          luts: [],
          oracles: [
            { oracle: "o1", value: null, error: `401 Token ${SECRET}` },
            { oracle: "o2", value: "1", error: null },
          ],
        }),
    });
    const run = liveSimulator({ client, feeds, variableOverrides }).simulate(aaplTiingo, hash);
    await expect(run).rejects.toThrow("no oracle signed an update: 401 Token [redacted]; ok");
  });

  it("reports a failed simulation with keys redacted", async () => {
    const client = fake({
      simulate: () => Promise.resolve({ slot: 1, error: `custom ${SECRET}` }),
    });
    const run = liveSimulator({ client, feeds, variableOverrides }).simulate(aaplTiingo, hash);
    await expect(run).rejects.toThrow("update simulation failed: custom [redacted]");
  });

  it("returns redacted per-oracle errors alongside successes", async () => {
    const client = fake({
      fetchUpdate: () =>
        Promise.resolve({
          ixs: [],
          luts: [],
          oracles: [{ oracle: "o1", value: null, error: `bad ${SECRET}` }],
        }),
    });
    const update = await liveSimulator({ client, feeds, variableOverrides }).simulate(
      aaplTiingo,
      hash,
    );
    expect(update.oracles).toEqual([{ oracle: "o1", value: null, error: "bad [redacted]" }]);
  });
});

describe("createFeeds", () => {
  const feedHash = (def: FeedDefinition) => computeFeedHash(DEVNET_QUEUE, def);

  it("stores jobs, creates one feed per definition and checks Crossbar's hash", async () => {
    const stored: string[] = [];
    const client = fake({
      storeJobs: (_, jobs) => {
        const def = defs.find(
          (d) =>
            JSON.stringify(d.jobs[0]?.tasks[0]) === JSON.stringify(jobs[0]?.toJSON().tasks?.[0]),
        );
        stored.push(def === undefined ? "?" : `${def.ticker}.${def.source}`);
        return Promise.resolve(def === undefined ? "" : `0x${feedHash(def)}`);
      },
    });
    const created = await createFeeds({ client, queue: DEVNET_QUEUE, defs, feedHash });
    expect(created).toHaveLength(14);
    expect(stored[0]).toBe("AAPL.tiingo");
    expect(created[0]).toMatchObject({
      ticker: "AAPL",
      source: "tiingo",
      feedHash: feedHash(aaplTiingo),
    });
    const json = JSON.parse(feedAccountsJson(created)) as Record<string, string[]>;
    expect(Object.keys(json)).toEqual(["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"]);
    expect(json["AAPL"]).toEqual([created[0]?.feed, created[1]?.feed]);
  });

  it("stops when Crossbar computes a different hash", async () => {
    const client = fake({ storeJobs: () => Promise.resolve("0xabc") });
    await expect(createFeeds({ client, queue: DEVNET_QUEUE, defs, feedHash })).rejects.toThrow(
      /Crossbar stored AAPL\/tiingo as 0xabc/,
    );
  });

  it("feedAccountsJson skips tickers with a missing source", () => {
    const created = [
      { ticker: "AAPL" as const, source: "tiingo" as const, feed: "f", feedHash: "h" },
    ];
    expect(feedAccountsJson(created)).toBe("{}");
  });
});
