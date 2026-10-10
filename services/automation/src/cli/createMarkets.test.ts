import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { computeStrikes } from "../strikes";
import {
  checkTestMarketGuard,
  createMarkets,
  isoDateSchema,
  type MarketOps,
  type PlannedMarket,
  planMarkets,
  prevClosesFileSchema,
  tradingDateNumber,
} from "./createMarkets";

const CLOSES = { AAPL: 23_000, META: 68_000, TSLA: 25_000 };

/** In-memory "chain": a set of existing market keys. */
function fakeChain(existing: Iterable<string> = []) {
  const markets = new Set<string>(existing);
  const calls: string[] = [];
  const id = (p: PlannedMarket): string =>
    `${p.key.symbol}:${p.key.tradingDate}:${p.key.strikeCents}`;
  const ops: MarketOps = {
    exists: (p) => Promise.resolve(markets.has(id(p))),
    create: (p) => {
      if (markets.has(id(p))) {
        return Promise.reject(new Error("duplicate"));
      }
      markets.add(id(p));
      calls.push(id(p));
      return Promise.resolve(`sig-${calls.length}`);
    },
  };
  return { ops, markets, calls };
}

describe("planMarkets", () => {
  it("lists each ticker's strike ladder for the day, with one close time", () => {
    const plan = planMarkets({ tradingDate: "2026-10-06", closes: CLOSES });
    const meta = plan.filter((p) => p.key.symbol === "META");
    expect(meta.map((p) => p.key.strikeCents)).toEqual([
      62_000n,
      64_000n,
      66_000n,
      68_000n,
      70_000n,
      72_000n,
      74_000n,
    ]);
    expect(plan.filter((p) => p.key.symbol === "AAPL")).toHaveLength(5);
    expect(new Set(plan.map((p) => p.closeTs)).size).toBe(1);
    // 16:00 ET on 2026-10-06 (EDT, UTC-4).
    expect(plan[0]?.closeTs).toBe(Date.UTC(2026, 9, 6, 20, 0, 0) / 1000);
    expect(plan.every((p) => p.key.tradingDate === 20_261_006)).toBe(true);
  });

  it("honours a close override and skips tickers without a previous close", () => {
    const plan = planMarkets({
      tradingDate: "2026-10-06",
      closes: { META: 68_000 },
      closeTs: 1_234,
    });
    expect(plan.every((p) => p.key.symbol === "META" && p.closeTs === 1_234)).toBe(true);
  });

  it("uses the early close on 2026-11-27 and refuses a holiday", () => {
    const early = planMarkets({ tradingDate: "2026-11-27", closes: { META: 68_000 } });
    expect(early[0]?.closeTs).toBe(Date.UTC(2026, 10, 27, 18, 0, 0) / 1000);
    expect(() => planMarkets({ tradingDate: "2026-11-26", closes: { META: 68_000 } })).toThrow(
      RangeError,
    );
  });

  it("refuses a weekend or holiday even when the close is overridden", () => {
    for (const tradingDate of ["2026-10-03", "2026-11-26", "2026-12-25"]) {
      expect(() => planMarkets({ tradingDate, closes: { META: 68_000 }, closeTs: 1_234 })).toThrow(
        RangeError,
      );
    }
  });

  it("plans exactly the strikes the calculator returns", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_000, max: 5_000_000 }), (close) => {
        const plan = planMarkets({ tradingDate: "2026-10-06", closes: { NVDA: close } });
        expect(plan.map((p) => Number(p.key.strikeCents))).toEqual(computeStrikes(close));
      }),
    );
  });
});

describe("createMarkets idempotency (NFR-05)", () => {
  const plan = planMarkets({ tradingDate: "2026-10-06", closes: CLOSES });

  it("creates every market once; a second run creates nothing", async () => {
    const chain = fakeChain();
    const first = await createMarkets(plan, chain.ops);
    expect(first.created).toHaveLength(plan.length);
    expect(first.skipped).toHaveLength(0);
    const second = await createMarkets(plan, chain.ops);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(plan.length);
    expect(chain.markets.size).toBe(plan.length);
    expect(new Set(chain.calls).size).toBe(plan.length);
  });

  it("finishes a partly created day without touching what exists", async () => {
    const chain = fakeChain(["META:20261006:68000", "META:20261006:70000"]);
    const report = await createMarkets(plan, chain.ops);
    expect(report.skipped).toHaveLength(2);
    expect(report.created).toHaveLength(plan.length - 2);
  });

  it("reports each creation as it happens, so a later failure keeps the earlier signatures", async () => {
    const chain = fakeChain();
    const seen: string[] = [];
    let n = 0;
    const flaky: MarketOps = {
      exists: chain.ops.exists,
      create: (p) => (++n === 4 ? Promise.reject(new Error("rpc down")) : chain.ops.create(p)),
    };
    await expect(
      createMarkets(plan, flaky, (p, signature) => seen.push(`${p.key.symbol}:${signature}`)),
    ).rejects.toThrow("rpc down");
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatch(/^AAPL:sig-1$/);
  });

  it("stops at the first failure and keeps what was created", async () => {
    const chain = fakeChain();
    let n = 0;
    const flaky: MarketOps = {
      exists: chain.ops.exists,
      create: (p) => (++n === 3 ? Promise.reject(new Error("rpc down")) : chain.ops.create(p)),
    };
    await expect(createMarkets(plan, flaky)).rejects.toThrow("rpc down");
    expect(chain.markets.size).toBe(2);
    const resumed = await createMarkets(plan, chain.ops);
    expect(resumed.skipped).toHaveLength(2);
    expect(chain.markets.size).toBe(plan.length);
  });
});

describe("inputs", () => {
  it("parses the previous closes file shape and rejects bad ones", () => {
    expect(
      prevClosesFileSchema.parse({ tradingDate: "2026-10-06", closes: { META: 68_000 } }),
    ).toEqual({ tradingDate: "2026-10-06", closes: { META: 68_000 } });
    expect(() =>
      prevClosesFileSchema.parse({ tradingDate: "2026-10-06", closes: { META: 680.5 } }),
    ).toThrow();
    expect(() => prevClosesFileSchema.parse({ tradingDate: "10/06", closes: {} })).toThrow();
    expect(tradingDateNumber("2026-10-06")).toBe(20_261_006);
  });

  it("accepts only real ISO calendar dates", () => {
    expect(isoDateSchema.parse("2026-10-06")).toBe("2026-10-06");
    for (const bad of [
      "2026-02-30",
      "2026-13-01",
      "2026-1-6",
      "10/06/2026",
      "",
      "2026-10-06T00:00",
    ]) {
      expect(isoDateSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("checkTestMarketGuard (P0-1: refuse test markets on devnet)", () => {
  it("allows --close-in-secs on localnet without --allow-test-close", () => {
    expect(() =>
      checkTestMarketGuard({
        hasCloseInSecs: true,
        allowTestClose: false,
        resolvedCluster: "localnet",
      }),
    ).not.toThrow();
  });

  it("allows --close-in-secs on devnet WITH --allow-test-close", () => {
    expect(() =>
      checkTestMarketGuard({
        hasCloseInSecs: true,
        allowTestClose: true,
        resolvedCluster: "devnet",
      }),
    ).not.toThrow();
  });

  it("refuses --close-in-secs on devnet without --allow-test-close", () => {
    expect(() =>
      checkTestMarketGuard({
        hasCloseInSecs: true,
        allowTestClose: false,
        resolvedCluster: "devnet",
      }),
    ).toThrow(/not allowed on devnet.*--allow-test-close/);
  });

  it("allows real markets (no --close-in-secs) on devnet", () => {
    expect(() =>
      checkTestMarketGuard({
        hasCloseInSecs: false,
        allowTestClose: false,
        resolvedCluster: "devnet",
      }),
    ).not.toThrow();
  });
});
