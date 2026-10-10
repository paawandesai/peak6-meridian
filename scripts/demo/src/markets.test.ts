import { type DemoSessions } from "@meridian/client";
import {
  type MarketOps,
  type PlannedMarket,
  type PrevCloseResult,
  RunState,
  runMorning,
  TICKERS,
} from "automation";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type CloseResolver, createCloseResolver } from "./closes";
import {
  type ChainMarket,
  type DemoMarketChain,
  parseTickers,
  planDemoMarkets,
  runDemoMarkets,
  strikesByTicker,
} from "./markets";

const NOW = new Date("2026-10-10T16:00:00Z"); // Saturday 12:00 ET
const CLOSE_TS = Date.UTC(2026, 9, 12, 0, 0) / 1000; // Sun Oct 11 20:00 ET
const PREV = {
  AAPL: 34_058,
  MSFT: 52_241,
  GOOGL: 34_846,
  AMZN: 25_474,
  NVDA: 23_074,
  META: 71_945,
  TSLA: 37_508,
};
const ASOF = { AAPL: 33_606, MSFT: 53_499 };

const keyOf = (p: PlannedMarket): string =>
  `${p.key.symbol}:${String(p.key.tradingDate)}:${p.key.strikeCents.toString()}`;

/** An in-memory chain: market key → close_ts. */
class FakeChain implements DemoMarketChain {
  readonly markets = new Map<string, number>();
  readonly created: PlannedMarket[] = [];
  failAfter = Number.POSITIVE_INFINITY;
  readonly marketOps: MarketOps = {
    exists: (p) => Promise.resolve(this.markets.has(keyOf(p))),
    create: (p) => {
      if (this.created.length >= this.failAfter) {
        return Promise.reject(new Error("rpc: blockhash not found"));
      }
      this.markets.set(keyOf(p), p.closeTs);
      this.created.push(p);
      return Promise.resolve(`sig${String(this.created.length)}`);
    },
  };
  readonly queriedDates: number[] = [];
  marketsOnDate(tradingDate: number): Promise<ChainMarket[]> {
    this.queriedDates.push(tradingDate);
    const out: ChainMarket[] = [];
    for (const [key, closeTs] of this.markets) {
      const [ticker = "", date = "", strike = "0"] = key.split(":");
      if (Number(date) === tradingDate) out.push({ ticker, strikeCents: BigInt(strike), closeTs });
    }
    return Promise.resolve(out);
  }
}

function closesFor(prev: Record<string, number>, asOf: Record<string, number>): CloseResolver {
  return createCloseResolver({
    file: Object.fromEntries(
      Object.keys({ ...prev, ...asOf }).map((t) => [
        t,
        {
          ...(prev[t] === undefined ? {} : { "2026-10-08": prev[t] }),
          ...(asOf[t] === undefined ? {} : { "2026-10-09": asOf[t] }),
        },
      ]),
    ),
    cache: {},
  });
}

const EMPTY: DemoSessions = { sessions: [] };
const base = {
  asOf: "2026-10-09",
  closeTs: CLOSE_TS,
  tradingDate: "2026-10-11",
  tickers: [...TICKERS],
  dryRun: false,
  now: NOW,
};

describe("parseTickers", () => {
  it("defaults to the MAG7 in config order and normalises a list", () => {
    expect(parseTickers(undefined)).toEqual([...TICKERS]);
    expect(parseTickers("")).toEqual([...TICKERS]);
    expect(parseTickers("tsla, aapl")).toEqual(["AAPL", "TSLA"]);
  });

  it("refuses an unknown ticker", () => {
    expect(() => parseTickers("AAPL,IBM")).toThrow(/unknown IBM/);
  });
});

describe("strike ladder parity with the morning job", () => {
  /** What automation's runMorning creates at 08:00 ET on AS_OF from the same previous closes. */
  async function morningStrikes(asOfMorning: Date, prev: Record<string, number>, prevDate: string) {
    const chain = new FakeChain();
    const result = await runMorning({
      now: () => asOfMorning,
      sleep: () => Promise.resolve(),
      prevClose: (ticker, date): Promise<PrevCloseResult> => {
        expect(date).toBe(prevDate);
        const cents = prev[ticker] ?? 0;
        return Promise.resolve({
          ok: true,
          value: {
            ticker,
            date,
            closeCents: cents,
            spreadBps: 0,
            sources: [
              { source: "tiingo", date, closeCents: cents },
              { source: "twelvedata", date, closeCents: cents },
            ],
          },
        });
      },
      marketOps: chain.marketOps,
      alerter: { send: () => Promise.resolve(true) },
      state: new RunState(),
      log: () => undefined,
      demoMode: "live",
      demoCloseInSecs: 3600,
      cluster: "localnet",
    });
    expect(result.status).toBe("ok");
    return strikesByTicker(chain.created);
  }

  it("matches runMorning for Fri 2026-10-09 (basis Thu 2026-10-08)", async () => {
    const morning = await morningStrikes(new Date("2026-10-09T12:00:00Z"), PREV, "2026-10-08");
    const demo = strikesByTicker(
      planDemoMarkets({
        asOf: "2026-10-09",
        tradingDate: "2026-10-11",
        closeTs: CLOSE_TS,
        prevCloses: PREV,
      }),
    );
    expect(demo).toEqual(morning);
    expect(demo.AAPL).toEqual([31_000, 32_000, 33_000, 34_000, 35_000, 36_000, 37_000]);
  });

  it("matches runMorning for any closes (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record(
          Object.fromEntries(
            TICKERS.map((t) => [t, fc.integer({ min: 1, max: 5_000_000 })]),
          ) as Record<string, fc.Arbitrary<number>>,
        ),
        async (prev) => {
          const morning = await morningStrikes(
            new Date("2026-10-09T12:00:00Z"),
            prev,
            "2026-10-08",
          );
          const plan = planDemoMarkets({
            asOf: "2026-10-09",
            tradingDate: "2026-10-11",
            closeTs: CLOSE_TS,
            prevCloses: prev,
          });
          expect(strikesByTicker(plan)).toEqual(morning);
          expect(new Set(plan.map((p) => p.key.tradingDate))).toEqual(new Set([20_261_011]));
          expect(new Set(plan.map((p) => p.closeTs))).toEqual(new Set([CLOSE_TS]));
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("runDemoMarkets", () => {
  it("creates every market, re-keyed to the demo date and close, and records the session", async () => {
    const chain = new FakeChain();
    const report = await runDemoMarkets(base, {
      closes: closesFor(PREV, ASOF),
      registry: EMPTY,
      chain,
    });
    expect(report.error).toBeUndefined();
    expect(chain.created.length).toBe(report.rows.length);
    expect(report.rows.every((r) => r.status === "created" && r.signature !== undefined)).toBe(
      true,
    );
    expect(
      chain.created.every((p) => p.key.tradingDate === 20_261_011 && p.closeTs === CLOSE_TS),
    ).toBe(true);
    expect(report.session).toMatchObject({
      tradingDate: "2026-10-11",
      asOf: "2026-10-09",
      closeTs: CLOSE_TS,
      createdAt: NOW.toISOString(),
      tickers: [...TICKERS],
      asOfCloseCentsByTicker: ASOF,
      prevCloseDate: "2026-10-08",
      prevCloseCentsByTicker: PREV,
    });
    expect(report.registry.sessions).toEqual([report.session]);
  });

  it("is idempotent: a second run skips every existing PDA and creates nothing", async () => {
    const chain = new FakeChain();
    const deps = { closes: closesFor(PREV, ASOF), registry: EMPTY, chain };
    const first = await runDemoMarkets(base, deps);
    const second = await runDemoMarkets(base, { ...deps, registry: first.registry });
    expect(second.rows.every((r) => r.status === "exists")).toBe(true);
    expect(chain.created.length).toBe(first.rows.length);
    expect(second.registry.sessions).toHaveLength(1);
    expect(second.registry.sessions[0]?.createdAt).toBe(NOW.toISOString());
  });

  it("creates only the missing markets after a partial run", async () => {
    const chain = new FakeChain();
    const plan = planDemoMarkets({
      asOf: "2026-10-09",
      tradingDate: "2026-10-11",
      closeTs: CLOSE_TS,
      prevCloses: PREV,
    });
    for (const p of plan.slice(0, 5)) chain.markets.set(keyOf(p), CLOSE_TS);
    const report = await runDemoMarkets(base, {
      closes: closesFor(PREV, ASOF),
      registry: EMPTY,
      chain,
    });
    expect(report.rows.filter((r) => r.status === "exists")).toHaveLength(5);
    expect(report.rows.filter((r) => r.status === "created")).toHaveLength(plan.length - 5);
  });

  it("refuses, creating nothing, when a planned PDA exists with another close", async () => {
    const chain = new FakeChain();
    const plan = planDemoMarkets({
      asOf: "2026-10-09",
      tradingDate: "2026-10-11",
      closeTs: CLOSE_TS,
      prevCloses: PREV,
    });
    const first = plan[0];
    if (first === undefined) throw new Error("empty plan");
    chain.markets.set(keyOf(first), CLOSE_TS - 86_400);
    await expect(
      runDemoMarkets(base, { closes: closesFor(PREV, ASOF), registry: EMPTY, chain }),
    ).rejects.toThrow(
      /already has markets at these strikes with another close[\s\S]*Sat Oct 10 2026 8:00 PM ET/,
    );
    expect(chain.created).toEqual([]);
  });

  it("defaults to the first free non-trading day, skipping one with conflicting markets", async () => {
    const chain = new FakeChain();
    const sat = planDemoMarkets({
      asOf: "2026-10-09",
      tradingDate: "2026-10-10",
      closeTs: CLOSE_TS,
      prevCloses: PREV,
    });
    for (const p of sat) chain.markets.set(keyOf(p), Date.UTC(2026, 9, 10, 20) / 1000);
    const report = await runDemoMarkets(
      { ...base, tradingDate: undefined },
      { closes: closesFor(PREV, ASOF), registry: EMPTY, chain },
    );
    expect(report.tradingDate).toBe("2026-10-11");
  });

  it("by default also skips a date holding any other markets, and re-uses its own session's date", async () => {
    const chain = new FakeChain();
    chain.markets.set("AAPL:20261010:99000", Date.UTC(2026, 9, 10, 20) / 1000);
    const deps = { closes: closesFor(PREV, ASOF), registry: EMPTY, chain };
    const first = await runDemoMarkets({ ...base, tradingDate: undefined }, deps);
    expect(first.tradingDate).toBe("2026-10-11");
    const again = await runDemoMarkets(
      { ...base, tradingDate: undefined },
      { ...deps, registry: first.registry },
    );
    expect(again.tradingDate).toBe("2026-10-11");
    expect(again.rows.every((r) => r.status === "exists")).toBe(true);
  });

  it("an explicit TRADING_DATE with other markets on it proceeds and counts them", async () => {
    const chain = new FakeChain();
    chain.markets.set("AAPL:20261011:99000", CLOSE_TS - 3600);
    const report = await runDemoMarkets(base, {
      closes: closesFor(PREV, ASOF),
      registry: EMPTY,
      chain,
    });
    expect(report.foreignMarkets).toBe(1);
    expect(chain.queriedDates).toEqual([20_261_011]);
  });

  it("refuses a real trading day as TRADING_DATE", async () => {
    await expect(
      runDemoMarkets(
        { ...base, tradingDate: "2026-10-12" },
        { closes: closesFor(PREV, ASOF), registry: EMPTY, chain: new FakeChain() },
      ),
    ).rejects.toThrow(/is an NYSE trading day/);
  });

  it("refuses when the strike basis is missing and names it", async () => {
    await expect(
      runDemoMarkets(base, {
        closes: closesFor({ AAPL: 1 }, {}),
        registry: EMPTY,
        chain: new FakeChain(),
      }),
    ).rejects.toThrow(/strike basis \(2026-10-08 closes\) unavailable[\s\S]*no MSFT close/);
  });

  it("refuses to reuse a registered date for another session", async () => {
    const chain = new FakeChain();
    const deps = { closes: closesFor(PREV, ASOF), registry: EMPTY, chain };
    const first = await runDemoMarkets(base, deps);
    await expect(
      runDemoMarkets({ ...base, closeTs: CLOSE_TS + 3600 }, { ...deps, registry: first.registry }),
    ).rejects.toThrow(/already a demo of 2026-10-09/);
  });

  it("DRY_RUN sends nothing and leaves the registry unchanged", async () => {
    const chain = new FakeChain();
    const report = await runDemoMarkets(
      { ...base, dryRun: true, tickers: ["AAPL"] },
      { closes: closesFor(PREV, ASOF), registry: EMPTY, chain },
    );
    expect(chain.created).toEqual([]);
    expect(report.registry).toBe(EMPTY);
    expect(new Set(report.rows.map((r) => r.status))).toEqual(new Set(["would create"]));
    expect(report.session.tickers).toEqual(["AAPL"]);
  });

  it("DRY_RUN without a chain only plans", async () => {
    const report = await runDemoMarkets(
      { ...base, dryRun: true },
      { closes: closesFor(PREV, {}), registry: EMPTY },
    );
    expect(new Set(report.rows.map((r) => r.status))).toEqual(
      new Set(["planned (chain not checked)"]),
    );
    expect(report.session.asOfCloseCentsByTicker).toEqual({});
  });

  it("refuses a real run without a chain", async () => {
    await expect(
      runDemoMarkets(base, { closes: closesFor(PREV, ASOF), registry: EMPTY }),
    ).rejects.toThrow(/no chain/);
  });

  it("keeps what was created when creation stops part-way, and reports why", async () => {
    const chain = new FakeChain();
    chain.failAfter = 3;
    const seen: string[] = [];
    const report = await runDemoMarkets(base, {
      closes: closesFor(PREV, ASOF),
      registry: EMPTY,
      chain,
      onCreated: (_p, sig) => seen.push(sig),
    });
    expect(report.error).toMatch(/blockhash not found/);
    expect(seen).toEqual(["sig1", "sig2", "sig3"]);
    expect(report.rows.filter((r) => r.status === "created")).toHaveLength(3);
    expect(
      report.rows.filter((r) => r.status === "NOT created (run stopped)").length,
    ).toBeGreaterThan(0);
    expect(report.registry.sessions).toHaveLength(1);
  });
});
