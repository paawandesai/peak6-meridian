import { type DemoSession, type DemoSessions } from "@meridian/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createCloseResolver } from "./closes";
import { type DemoOpenMarket, type DemoSettleChain, outcomeFor, runDemoSettle } from "./settle";

const CLOSE_TS = Date.UTC(2026, 9, 12, 0, 0) / 1000; // Sun Oct 11 20:00 ET
const DELAY = 3600;
const ADMIN = "Admin1111111111111111111111111111111111111";

const SESSION: DemoSession = {
  tradingDate: "2026-10-11",
  asOf: "2026-10-09",
  closeTs: CLOSE_TS,
  createdAt: "2026-10-10T16:00:00.000Z",
  tickers: ["AAPL", "MSFT"],
  strikesByTicker: { AAPL: [33_000, 34_000], MSFT: [53_000, 54_000] },
  asOfCloseCentsByTicker: { AAPL: 33_606 },
};
const REGISTRY: DemoSessions = { sessions: [SESSION] };

const market = (ticker: string, strikeCents: bigint): DemoOpenMarket => ({
  address: `${ticker}-${strikeCents.toString()}`,
  ticker,
  strikeCents,
  closeTs: CLOSE_TS,
});
const MARKETS = [
  market("AAPL", 33_000n),
  market("AAPL", 34_000n),
  market("MSFT", 53_000n),
  market("MSFT", 54_000n),
];

class FakeChain implements DemoSettleChain {
  readonly settled: { address: string; price: bigint }[] = [];
  readonly requestedDates: number[] = [];
  fail = new Set<string>();
  constructor(readonly markets: DemoOpenMarket[] = MARKETS) {}
  config() {
    return Promise.resolve({ admin: ADMIN, overrideDelaySecs: DELAY });
  }
  openMarkets(tradingDate: number) {
    this.requestedDates.push(tradingDate);
    return Promise.resolve(this.markets);
  }
  settle = (m: DemoOpenMarket, price: bigint): Promise<string> => {
    if (this.fail.has(m.address)) return Promise.reject(new Error("OverrideTooEarly"));
    this.settled.push({ address: m.address, price });
    return Promise.resolve(`sig-${m.address}`);
  };
}

const at = (secs: number): Date => new Date(secs * 1000);
const closes = createCloseResolver({ file: { MSFT: { "2026-10-09": 53_499 } }, cache: {} });
const input = { tradingDate: "2026-10-11", now: at(CLOSE_TS + DELAY), dryRun: false, admin: ADMIN };

describe("outcomeFor", () => {
  it("is YES exactly when price ≥ strike (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 ** 9 }),
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        (p, k) => {
          expect(outcomeFor(p, k)).toBe(BigInt(p) >= k ? "YES" : "NO");
        },
      ),
    );
    expect(outcomeFor(34_000, 34_000n)).toBe("YES");
    expect(outcomeFor(33_999, 34_000n)).toBe("NO");
  });
});

describe("runDemoSettle", () => {
  it("settles each open market at the AS_OF close of its ticker and records a learned close", async () => {
    const chain = new FakeChain();
    const report = await runDemoSettle(input, { registry: REGISTRY, chain, closes });
    expect(chain.requestedDates).toEqual([20_261_011]);
    expect(chain.settled).toEqual([
      { address: "AAPL-33000", price: 33_606n },
      { address: "AAPL-34000", price: 33_606n },
      { address: "MSFT-53000", price: 53_499n },
      { address: "MSFT-54000", price: 53_499n },
    ]);
    expect(report.rows.map((r) => r.outcome)).toEqual(["YES", "NO", "YES", "NO"]);
    expect(report.rows.every((r) => r.status === "settled")).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.registry.sessions[0]?.asOfCloseCentsByTicker).toEqual({
      AAPL: 33_606,
      MSFT: 53_499,
    });
  });

  it("prefers the registry's close over the closes sources", async () => {
    const chain = new FakeChain([market("AAPL", 33_000n)]);
    const other = createCloseResolver({ file: { AAPL: { "2026-10-09": 1 } }, cache: {} });
    const report = await runDemoSettle(input, { registry: REGISTRY, chain, closes: other });
    expect(chain.settled).toEqual([{ address: "AAPL-33000", price: 33_606n }]);
    expect(report.registry).toBe(REGISTRY);
  });

  it("reports too early, with the ET time it is allowed from, and sends nothing", async () => {
    const chain = new FakeChain();
    const report = await runDemoSettle(
      { ...input, now: at(CLOSE_TS + DELAY - 1) },
      { registry: REGISTRY, chain, closes },
    );
    expect(chain.settled).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.rows.every((r) => r.status === "too early")).toBe(true);
    expect(report.rows[0]?.detail).toBe("too early, allowed from Sun Oct 11 2026 9:00 PM ET");
    expect(report.rows[0]?.allowedFromTs).toBe(CLOSE_TS + DELAY);
  });

  it("DRY_RUN previews prices and outcomes without sending or writing", async () => {
    const chain = new FakeChain();
    const report = await runDemoSettle(
      { ...input, dryRun: true },
      { registry: REGISTRY, chain, closes },
    );
    expect(chain.settled).toEqual([]);
    expect(report.rows.every((r) => r.status === "would settle")).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.registry).toBe(REGISTRY);
  });

  it("marks a ticker with no known AS_OF close and settles the rest", async () => {
    const chain = new FakeChain();
    const none = createCloseResolver({ file: {}, cache: {} });
    const report = await runDemoSettle(input, { registry: REGISTRY, chain, closes: none });
    expect(report.rows.filter((r) => r.status === "no price").map((r) => r.market.ticker)).toEqual([
      "MSFT",
      "MSFT",
    ]);
    expect(chain.settled).toHaveLength(2);
    expect(report.ok).toBe(false);
  });

  it("records a failed transaction and carries on", async () => {
    const chain = new FakeChain();
    chain.fail.add("AAPL-33000");
    const report = await runDemoSettle(input, { registry: REGISTRY, chain, closes });
    expect(report.rows[0]).toMatchObject({ status: "failed", detail: "OverrideTooEarly" });
    expect(chain.settled).toHaveLength(3);
    expect(report.ok).toBe(false);
  });

  it("is ok with nothing open", async () => {
    const report = await runDemoSettle(input, {
      registry: REGISTRY,
      chain: new FakeChain([]),
      closes,
    });
    expect(report.rows).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("refuses a trading day, an unregistered date and a key that is not Config's admin", async () => {
    const deps = { registry: REGISTRY, chain: new FakeChain(), closes };
    await expect(runDemoSettle({ ...input, tradingDate: "2026-10-09" }, deps)).rejects.toThrow(
      /is an NYSE trading day/,
    );
    await expect(runDemoSettle({ ...input, tradingDate: "2026-10-10" }, deps)).rejects.toThrow(
      /no demo session registered for 2026-10-10/,
    );
    await expect(runDemoSettle({ ...input, admin: "Someone" }, deps)).rejects.toThrow(
      /not Config's admin/,
    );
  });
});
