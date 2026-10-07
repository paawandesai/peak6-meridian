import { Keypair } from "@solana/web3.js";
import { FeedHash } from "@switchboard-xyz/common";
import { ON_DEMAND_DEVNET_QUEUE } from "@switchboard-xyz/on-demand";
import { describe, expect, it } from "vitest";

import { DEFAULT_FEEDS_DIR } from "./cli";
import { DEVNET_QUEUE } from "./devnet";
import { loadFeedDefinitions, type FeedDefinition } from "./feeds";
import {
  computeFeedHash,
  runSpike,
  toOracleJobs,
  type FeedUpdate,
  type UpdateSimulator,
} from "./spike";

const defs = loadFeedDefinitions(DEFAULT_FEEDS_DIR);
const aapl = defs.filter((d) => d.ticker === "AAPL");

/** Simulator answering every oracle with the value chosen for the definition. */
function fakeSimulator(valueOf: (def: FeedDefinition) => string | null | Error): UpdateSimulator {
  return {
    simulate(def): Promise<FeedUpdate> {
      const value = valueOf(def);
      if (value instanceof Error) return Promise.reject(value);
      const oracles = ["o1", "o2", "o3"].map((oracle) => ({
        oracle,
        value,
        error: value === null ? "HTTP 500" : null,
      }));
      return Promise.resolve({ feed: `${def.ticker}-${def.source}`, slot: 7, oracles });
    },
  };
}

describe("computeFeedHash", () => {
  it("is the SDK's sha256(queue ‖ jobs) as 64 hex chars", () => {
    const def = defs[0];
    if (def === undefined) throw new Error("no definitions");
    const hash = computeFeedHash(DEVNET_QUEUE, def);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(FeedHash.compute(DEVNET_QUEUE.toBuffer(), toOracleJobs(def)).toString("hex"));
  });

  it("is unique per definition and changes with the queue (pinning, AB-04)", () => {
    const hashes = defs.map((d) => computeFeedHash(DEVNET_QUEUE, d));
    expect(new Set(hashes).size).toBe(defs.length);
    const other = Keypair.generate().publicKey;
    expect(computeFeedHash(other, aapl[0] as FeedDefinition)).not.toBe(hashes[0]);
  });

  it("uses the SDK's default devnet queue", () => {
    expect(DEVNET_QUEUE.equals(ON_DEMAND_DEVNET_QUEUE)).toBe(true);
  });
});

describe("runSpike", () => {
  it("reports value, slot and oracles per feed and the spread per ticker", async () => {
    const report = await runSpike({
      mode: "dry-run",
      queue: DEVNET_QUEUE,
      defs: aapl,
      simulator: fakeSimulator((d) => (d.source === "tiingo" ? "100.00" : "100.04")),
    });
    expect(report.ok).toBe(true);
    expect(report.queue).toBe(DEVNET_QUEUE.toBase58());
    expect(report.feeds.map((f) => [f.source, f.value, f.slot, f.oracles.length])).toEqual([
      ["tiingo", "100", 7, 3],
      ["twelvedata", "100.04", 7, 3],
    ]);
    expect(report.tickers).toEqual([{ ticker: "AAPL", spreadBps: "3.99", withinMaxSpread: true }]);
  });

  it("fails a ticker whose sources disagree by more than 5 bps (AB-13)", async () => {
    const report = await runSpike({
      mode: "dry-run",
      queue: DEVNET_QUEUE,
      defs: aapl,
      simulator: fakeSimulator((d) => (d.source === "tiingo" ? "100.00" : "100.06")),
    });
    expect(report.ok).toBe(false);
    expect(report.tickers[0]?.withinMaxSpread).toBe(false);
  });

  it("records a feed with no oracle value or a failed simulation as an error", async () => {
    const report = await runSpike({
      mode: "devnet",
      queue: DEVNET_QUEUE,
      defs: aapl,
      simulator: fakeSimulator((d) => (d.source === "tiingo" ? null : new Error("rpc down"))),
    });
    expect(report.ok).toBe(false);
    expect(report.feeds.map((f) => f.error)).toEqual(["no oracle returned a value", "rpc down"]);
    expect(report.feeds[1]).toMatchObject({ feed: null, slot: null, oracles: [] });
    expect(report.tickers[0]).toEqual({ ticker: "AAPL", spreadBps: null, withinMaxSpread: false });
  });

  it("reports non-Error rejections as text", async () => {
    const simulator: UpdateSimulator = { simulate: () => Promise.reject("boom") };
    const report = await runSpike({ mode: "devnet", queue: DEVNET_QUEUE, defs: aapl, simulator });
    expect(report.feeds[0]?.error).toBe("boom");
  });
});
