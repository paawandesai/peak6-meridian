import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { assertCluster, DEVNET_GENESIS_HASH } from "./cluster";
import { parseSettleNowArgs, settleNow, type SettleNowParams } from "./settleNow";
import { SettleWorld } from "./testing";

const CLOSE_TS = 1_791_316_800;
const PAYER_PATH = "/home/someone/secret-dir/payer-keypair.json";

function setup(markets: { ticker: string; strike: number }[], afterClose = 0) {
  const world = new SettleWorld({
    markets,
    closeTs: CLOSE_TS,
    start: new Date((CLOSE_TS + afterClose) * 1_000),
  });
  const out: string[] = [];
  const loaded: string[] = [];
  const payer = Keypair.generate(); // not the automation key
  const params = (overrides: Partial<SettleNowParams> = {}): SettleNowParams => {
    const deps = world.deps();
    return {
      argv: ["--payer", PAYER_PATH],
      cluster: "localnet",
      rpcUrl: "http://127.0.0.1:8899",
      assertCluster,
      getGenesisHash: () => Promise.resolve(DEVNET_GENESIS_HASH),
      loadKeypair: (path) => {
        loaded.push(path);
        return payer;
      },
      runtime: () =>
        Promise.resolve({
          chain: deps.chain,
          verifyClose: deps.verifyClose,
          adapter: deps.adapter,
          buildSettleIxs: deps.buildSettleIxs,
          executor: deps.executor,
          alerter: deps.alerter,
          incidents: deps.incidents,
          log: deps.log,
        }),
      now: world.clock.now,
      out: (line) => out.push(line),
      ...overrides,
    };
  };
  return { world, out, loaded, payer, params };
}

describe("parseSettleNowArgs", () => {
  it("takes --payer and an optional real --date", () => {
    expect(parseSettleNowArgs(["--payer", "k.json"])).toEqual({ payer: "k.json" });
    expect(parseSettleNowArgs(["--payer", "k.json", "--date", "2026-10-06"])).toEqual({
      payer: "k.json",
      date: "2026-10-06",
    });
  });

  it("rejects anything else with a usage message that echoes no value", () => {
    for (const argv of [
      [],
      ["--payer"],
      ["--date", "2026-10-06"],
      ["--payer", "k", "--date", "2026-02-30"],
      ["--payer", "k", "--unknown", "x"],
      ["--payer", "--date"],
    ]) {
      expect(() => parseSettleNowArgs(argv)).toThrow(/usage: settle-now/);
    }
    try {
      parseSettleNowArgs(["--payer", "k", "--date", "SECRET-DATE"]);
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-DATE");
    }
  });
});

describe("settleNow (AC7)", () => {
  it("settles all open, closed markets with a payer that is not the automation key", async () => {
    const t = setup([
      { ticker: "META", strike: 640 },
      { ticker: "META", strike: 680 },
      { ticker: "AAPL", strike: 230 },
    ]);
    const result = await settleNow(t.params());
    expect(result).toEqual({ settled: 3, failed: 0, deferred: 0 });
    expect(t.world.open).toEqual([]);
    expect(t.out).toEqual(["settled 3 market(s) on localnet"]);
    // It ran now, without the 5-minute wait, and nothing was sent before the close.
    expect(t.world.executor.sent.length).toBeGreaterThan(0);
  });

  it("skips already-settled markets and reports when nothing is left", async () => {
    const t = setup([{ ticker: "META", strike: 680 }]);
    await settleNow(t.params());
    const sent = t.world.executor.sent.length;
    const again = await settleNow(t.params());
    expect(again).toEqual({ settled: 0, failed: 0, deferred: 0 });
    expect(t.world.executor.sent.length).toBe(sent);
    expect(t.out.at(-1)).toMatch(/nothing to settle/);
  });

  it("leaves a market that has not closed yet alone", async () => {
    const t = setup([{ ticker: "META", strike: 680 }], -10);
    expect(await settleNow(t.params())).toEqual({ settled: 0, failed: 0, deferred: 0 });
    expect(t.world.executor.sent).toEqual([]);
  });

  it("--date restricts the run to that trading date", async () => {
    const t = setup([{ ticker: "META", strike: 680 }]);
    const result = await settleNow(
      t.params({ argv: ["--payer", PAYER_PATH, "--date", "2026-10-05"] }),
    );
    expect(result.settled).toBe(0);
    expect(t.world.executor.sent).toEqual([]);
  });

  it("reports a failing ticker and returns it as failed (no retry wait)", async () => {
    const t = setup([{ ticker: "META", strike: 680 }]);
    t.world.sourceDate = "2026-10-05";
    const result = await settleNow(t.params());
    expect(result).toEqual({ settled: 0, failed: 1, deferred: 0 });
    expect(t.out.join("\n")).toMatch(/FAILED META:2026-10-06/);
    expect(t.world.clock.sleeps).toEqual([]);
  });

  it("skips a weekend group without any data-API request and says to use the override (#53)", async () => {
    const t = setup([{ ticker: "META", strike: 680 }]);
    t.world.open = t.world.open.map((m) => ({ ...m, tradingDate: 20_261_010 })); // a Saturday
    const result = await settleNow(t.params());
    expect(result).toEqual({ settled: 0, failed: 0, deferred: 0 });
    expect(t.world.httpCalls).toEqual([]);
    expect(t.out).toEqual([
      "settled 0 market(s) on localnet",
      "SKIPPED META:2026-10-10: not_a_trading_day (no completed session; use the admin override)",
    ]);
  });

  it("stays within the data-API cap and lists what it deferred (#53)", async () => {
    const t = setup([
      { ticker: "META", strike: 640 },
      { ticker: "AAPL", strike: 230 },
    ]);
    // One devnet attempt costs 4 requests (2 checks + 2 oracle fetches): a cap of 4 fits one group.
    const result = await settleNow(t.params({ maxApiCallsPerRun: 4 }));
    expect(result).toEqual({ settled: 1, failed: 0, deferred: 1 });
    expect(t.world.httpCalls).toHaveLength(2);
    expect(t.out.at(-1)).toBe(
      "DEFERRED META:2026-10-06: data-API budget or rate-limit backoff; run settle-now again in a minute",
    );
    // Running it again settles the rest.
    expect(await settleNow(t.params({ maxApiCallsPerRun: 4 }))).toEqual({
      settled: 1,
      failed: 0,
      deferred: 0,
    });
    expect(t.world.open).toEqual([]);
  });

  it("refuses a cluster assertCluster does not accept, before loading any key", async () => {
    const t = setup([{ ticker: "META", strike: 680 }]);
    for (const cluster of ["mainnet-beta", "testnet"]) {
      await expect(settleNow(t.params({ cluster }))).rejects.toThrow(/unsupported cluster/);
    }
    await expect(
      settleNow(
        t.params({
          cluster: "devnet",
          rpcUrl: "https://mainnet.example/?api-key=SECRET123",
          getGenesisHash: () => Promise.resolve("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"),
        }),
      ),
    ).rejects.toThrow(/not devnet/);
    expect(t.loaded).toEqual([]);
    expect(t.world.executor.sent).toEqual([]);
  });

  it("never prints the keypair path or its contents, not even when loading fails", async () => {
    const t = setup([{ ticker: "META", strike: 680 }]);
    await settleNow(t.params());
    expect(t.out.join("\n")).not.toContain(PAYER_PATH);
    expect(JSON.stringify(t.world.logger.lines)).not.toContain(PAYER_PATH);
    const failing = setup([{ ticker: "META", strike: 680 }]);
    const error = await settleNow(
      failing.params({
        loadKeypair: () => {
          throw new Error(`ENOENT ${PAYER_PATH} [1,2,3,SECRETBYTES]`);
        },
      }),
    ).catch((e: unknown) => String(e));
    expect(error).toMatch(/cannot load the payer keypair/);
    expect(error).not.toContain(PAYER_PATH);
    expect(error).not.toContain("SECRETBYTES");
  });
});
