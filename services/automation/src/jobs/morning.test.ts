import { describe, expect, it } from "vitest";

import { fetchPrevClose, type PrevCloseResult } from "../prevCloses";
import { RunState } from "../state";
import { fakeSourcesHttp, type FakeSourcesOptions } from "../testing/fakeHttp";
import { FakeChain, FakeClock, RecordingAlerter, recordingLogger } from "../testing/harness";
import { backoffMs, catchUpDue, morningDeadline, runMorning, type MorningDeps } from "./morning";

/** 08:00 ET on 2026-10-06 (a Tuesday; EDT = UTC-4). */
const TUESDAY_0800 = new Date("2026-10-06T12:00:00Z");
const CLOSES = {
  AAPL: 23_000,
  MSFT: 41_500,
  GOOGL: 17_500,
  AMZN: 22_000,
  NVDA: 18_000,
  META: 68_000,
  TSLA: 25_000,
};

function setup(start: Date, sources?: Partial<FakeSourcesOptions> & { date: string }) {
  const clock = new FakeClock(start);
  const chain = new FakeChain();
  const alerter = new RecordingAlerter();
  const state = new RunState();
  const logger = recordingLogger();
  const http = fakeSourcesHttp({ closes: CLOSES, ...sources, date: sources?.date ?? "2026-10-05" });
  const deps: MorningDeps = {
    now: clock.now,
    sleep: clock.sleep,
    prevClose: (ticker, date) =>
      fetchPrevClose(
        { http, tiingoApiKey: "test-key", twelveDataApiKey: "test-key" },
        ticker,
        date,
      ),
    marketOps: chain,
    alerter,
    state,
    log: logger.log,
  };
  return { clock, chain, alerter, state, logger, http, deps };
}

describe("runMorning: trading days", () => {
  it("creates the day's markets from two agreeing sources (regular close 16:00 ET)", async () => {
    const t = setup(TUESDAY_0800);
    const result = await runMorning(t.deps);
    expect(result).toMatchObject({
      status: "ok",
      tradingDate: "2026-10-06",
      attempts: 1,
      existed: 0,
    });
    expect(result.created).toBe(t.chain.markets.size);
    expect(t.chain.markets.size).toBe(38);
    const closeTs = new Set([...t.chain.markets.values()].map((m) => m.closeTs));
    expect([...closeTs]).toEqual([Date.UTC(2026, 9, 6, 20, 0, 0) / 1000]);
    expect(t.alerter.alerts).toEqual([]);
    expect(t.state.lastMorning).toMatchObject({
      status: "ok",
      created: 38,
      tradingDate: "2026-10-06",
    });
  });

  it("is skipped on a holiday: no data fetched, nothing created, no alert (AC1)", async () => {
    // Thanksgiving, 08:00 EST = 13:00Z.
    const t = setup(new Date("2026-11-26T13:00:00Z"));
    const result = await runMorning(t.deps);
    expect(result).toMatchObject({ status: "skipped", tradingDate: "2026-11-26", created: 0 });
    expect(t.chain.createCalls).toEqual([]);
    expect(t.http.calls).toEqual([]);
    expect(t.alerter.alerts).toEqual([]);
    expect(t.state.lastMorning?.status).toBe("skipped");
  });

  it("is skipped on a weekend", async () => {
    const t = setup(new Date("2026-10-10T12:00:00Z")); // Saturday
    expect((await runMorning(t.deps)).status).toBe("skipped");
    expect(t.chain.createCalls).toEqual([]);
  });

  it("uses a 13:00 ET close on an early-close day (AC1)", async () => {
    // Day after Thanksgiving, 08:00 EST = 13:00Z; the previous trading day is Wed 2026-11-25.
    const t = setup(new Date("2026-11-27T13:00:00Z"), { date: "2026-11-25" });
    const result = await runMorning(t.deps);
    expect(result.status).toBe("ok");
    expect(result.tradingDate).toBe("2026-11-27");
    const closeTs = new Set([...t.chain.markets.values()].map((m) => m.closeTs));
    expect([...closeTs]).toEqual([Date.UTC(2026, 10, 27, 18, 0, 0) / 1000]);
    expect(t.http.calls.every((url) => !url.includes("2026-11-26"))).toBe(true);
  });

  it("re-running creates no duplicates and does not fail on existing markets (AC2, NFR-05)", async () => {
    const t = setup(TUESDAY_0800);
    const first = await runMorning(t.deps);
    const second = await runMorning(t.deps);
    expect(second).toMatchObject({ status: "ok", created: 0, existed: first.created });
    expect(t.chain.createCalls).toHaveLength(first.created);
    expect(
      new Set(t.chain.createCalls.map((m) => `${m.key.symbol}${m.key.strikeCents}`)).size,
    ).toBe(first.created);
    expect(t.alerter.alerts).toEqual([]);
  });
});

describe("runMorning: failures, retries and the single alert (AC3)", () => {
  it("retries with backoff until 08:30 ET when the sources disagree, then alerts exactly once", async () => {
    const t = setup(TUESDAY_0800, { date: "2026-10-05", twelveDataSkewCents: 500 });
    const result = await runMorning(t.deps);
    expect(result.status).toBe("failed");
    expect(result.created).toBe(0);
    expect(result.failedTickers).toHaveLength(7);
    // Backoff 15, 30, 60, 120, 240 × 5 s, then the last delay is clamped so the final attempt is
    // made exactly at 08:30 ET (not up to four minutes early): 12 attempts in all.
    expect(result.attempts).toBe(12);
    expect(t.clock.sleeps.at(-1)).toBeLessThan(240_000);
    expect(t.clock.ms).toBe(morningDeadline("2026-10-06"));
    expect(t.chain.createCalls).toEqual([]);
    expect(t.clock.sleeps.slice(0, 4)).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(t.alerter.alerts).toHaveLength(1);
    expect(t.alerter.alerts[0]).toMatchObject({ kind: "morning_failed" });
    expect(t.alerter.alerts[0]?.summary).toContain("2026-10-06");
    expect(t.state.lastMorning).toMatchObject({ status: "failed", attempts: result.attempts });
    expect(t.state.failures).toHaveLength(1);
  });

  it("alerts once when both sources are down", async () => {
    const t = setup(TUESDAY_0800, { date: "2026-10-05", tiingoDown: true, twelveDataDown: true });
    const result = await runMorning(t.deps);
    expect(result.status).toBe("failed");
    expect(t.alerter.alerts).toHaveLength(1);
    expect(JSON.stringify(t.alerter.alerts[0])).toContain("source_unavailable");
    expect(t.chain.createCalls).toEqual([]);
  });

  it("recovers on a later attempt without any alert", async () => {
    const t = setup(TUESDAY_0800);
    let calls = 0;
    const real = t.deps.prevClose;
    const flaky = async (ticker: string, date: string): Promise<PrevCloseResult> => {
      calls += 1;
      return calls <= 7 * 2
        ? { ok: false, error: { kind: "source_unavailable", ticker, date, message: "HTTP 503" } }
        : real(ticker, date);
    };
    const result = await runMorning({ ...t.deps, prevClose: flaky });
    expect(result).toMatchObject({ status: "ok", attempts: 3 });
    expect(t.alerter.alerts).toEqual([]);
    expect(t.chain.markets.size).toBe(38);
  });

  it("makes a final attempt at 08:30 ET, so a source that recovers just in time means no alert", async () => {
    const t = setup(TUESDAY_0800);
    const real = t.deps.prevClose;
    const deadline = morningDeadline("2026-10-06");
    const prevClose = (ticker: string, date: string): Promise<PrevCloseResult> =>
      t.clock.ms < deadline
        ? Promise.resolve({
            ok: false,
            error: { kind: "source_unavailable", ticker, date, message: "HTTP 503" },
          })
        : real(ticker, date);
    const result = await runMorning({ ...t.deps, prevClose });
    expect(result).toMatchObject({ status: "ok", attempts: 12 });
    expect(t.clock.ms).toBe(deadline);
    expect(t.alerter.alerts).toEqual([]);
    expect(t.chain.markets.size).toBe(38);
  });

  it("creates what it can and alerts only for the tickers still failing", async () => {
    const t = setup(TUESDAY_0800);
    const real = t.deps.prevClose;
    const prevClose = (ticker: string, date: string): Promise<PrevCloseResult> =>
      ticker === "TSLA"
        ? Promise.resolve({
            ok: false,
            error: { kind: "sources_disagree", ticker, date, message: "tiingo vs twelvedata" },
          })
        : real(ticker, date);
    const result = await runMorning({ ...t.deps, prevClose });
    expect(result.status).toBe("failed");
    expect(result.failedTickers).toEqual(["TSLA"]);
    expect(result.created).toBe(33);
    expect(t.alerter.alerts).toHaveLength(1);
    expect(t.alerter.alerts[0]?.details?.failedTickers).toEqual(["TSLA"]);
  });

  it("retries RPC errors and never puts a URL (possible credentials) into logs or alerts", async () => {
    const t = setup(TUESDAY_0800);
    t.chain.failCreates = {
      remaining: 1,
      message: "failed to get info about account https://rpc.example/?api-key=SECRET",
    };
    const result = await runMorning(t.deps);
    expect(result.status).toBe("ok");
    expect(result.attempts).toBe(2);
    expect(JSON.stringify(t.logger.lines)).not.toContain("SECRET");

    const failing = setup(TUESDAY_0800);
    failing.chain.failCreates = {
      remaining: 1_000,
      message: "boom https://rpc.example/?api-key=SECRET",
    };
    await runMorning(failing.deps);
    expect(failing.alerter.alerts).toHaveLength(1);
    expect(JSON.stringify(failing.alerter.alerts)).not.toContain("SECRET");
    expect(JSON.stringify(failing.alerter.alerts)).toContain("<url>");
  });

  it("makes one attempt, with no sleeping, when started after 08:30", async () => {
    const t = setup(new Date("2026-10-06T12:45:00Z"), { date: "2026-10-05", tiingoDown: true });
    const result = await runMorning(t.deps);
    expect(result).toMatchObject({ status: "failed", attempts: 1 });
    expect(t.clock.sleeps).toEqual([]);
    expect(t.alerter.alerts).toHaveLength(1);
  });

  it("alerts once without retrying when the calendar does not cover the year", async () => {
    const t = setup(new Date("2027-01-04T13:00:00Z"));
    const result = await runMorning(t.deps);
    expect(result).toMatchObject({ status: "failed", attempts: 0 });
    expect(t.alerter.alerts).toHaveLength(1);
    expect(t.alerter.alerts[0]?.summary).toContain("calendar");
    expect(t.http.calls).toEqual([]);
  });
});

describe("schedule helpers", () => {
  it("backs off 15 s, 30 s, 60 s, … capped at 4 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(backoffMs)).toEqual([
      15_000, 30_000, 60_000, 120_000, 240_000, 240_000, 240_000,
    ]);
    expect(backoffMs(0)).toBe(15_000);
  });

  it("puts the deadline at 08:30 ET, in EDT and EST alike", () => {
    expect(morningDeadline("2026-10-06")).toBe(Date.UTC(2026, 9, 6, 12, 30));
    expect(morningDeadline("2026-12-01")).toBe(Date.UTC(2026, 11, 1, 13, 30));
  });
});

describe("catchUpDue", () => {
  it("is due from 08:00 ET until the close on a trading day", () => {
    expect(catchUpDue(new Date("2026-10-06T11:59:59Z"))).toBe(false); // 07:59:59 ET
    expect(catchUpDue(new Date("2026-10-06T12:00:00Z"))).toBe(true); // 08:00 ET
    expect(catchUpDue(new Date("2026-10-06T19:59:59Z"))).toBe(true);
    expect(catchUpDue(new Date("2026-10-06T20:00:00Z"))).toBe(false); // closed
  });

  it("uses the early close and skips holidays and weekends", () => {
    expect(catchUpDue(new Date("2026-11-27T17:59:59Z"))).toBe(true); // 12:59:59 EST
    expect(catchUpDue(new Date("2026-11-27T18:00:00Z"))).toBe(false); // early close 13:00 ET
    expect(catchUpDue(new Date("2026-11-26T15:00:00Z"))).toBe(false);
    expect(catchUpDue(new Date("2026-10-10T15:00:00Z"))).toBe(false);
  });

  it("is due when the calendar does not cover the year, so the job can alert", () => {
    expect(catchUpDue(new Date("2027-01-04T15:00:00Z"))).toBe(true);
  });
});
