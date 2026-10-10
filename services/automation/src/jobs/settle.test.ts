import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { HttpGet } from "../prevCloses";
import type { OracleUpdateAdapter } from "../switchboard";
import {
  checkBalance,
  JOB_OPTIONS,
  MAX_QUIET_ATTEMPTS,
  QUIET_RETRY_MS,
  createSettlementJob,
  isoDate,
  RETRY_WINDOW_MS,
  runSettlement,
  SETTLE_DELAY_SECS,
  SETTLEMENT_CRON,
  type SettleResult,
} from "./settle";
import { TransactionInstruction } from "@solana/web3.js";

import { fakeSourcesHttp, SettleWorld } from "../testing";

/** The job runs every minute (cron); tests drive it run by run. */
const RUN_EVERY_MS = 60_000;

/** Runs the job once a minute until the 15-minute window of a group failing from now is over. */
async function failThroughWindow(w: SettleWorld): Promise<SettleResult[]> {
  const results: SettleResult[] = [];
  for (let elapsed = 0; elapsed <= RETRY_WINDOW_MS; elapsed += RUN_EVERY_MS) {
    if (elapsed > 0) {
      await w.clock.sleep(RUN_EVERY_MS);
    }
    results.push(await runSettlement(w.deps()));
  }
  return results;
}

const CLOSE_TS = 1_791_316_800; // 2026-10-06 16:00 ET (20:00Z)
const at = (secondsAfterClose: number): Date => new Date((CLOSE_TS + secondsAfterClose) * 1_000);

function world(
  markets: { ticker: string; strike: number; tradingDate?: number }[],
  after = SETTLE_DELAY_SECS,
  closeTs = CLOSE_TS,
): SettleWorld {
  return new SettleWorld({ markets, closeTs, start: new Date((closeTs + after) * 1_000) });
}

describe("runSettlement: what is due and when (AB-05)", () => {
  it("sends nothing before close + 5 minutes", async () => {
    const w = world([{ ticker: "META", strike: 680 }], SETTLE_DELAY_SECS - 1);
    const result = await runSettlement(w.deps());
    expect(result.status).toBe("idle");
    expect(w.executor.sent).toEqual([]);
    expect(w.verifyCalls).toEqual([]);
  });

  it("settles from exactly close + 5 minutes", async () => {
    const w = world([{ ticker: "META", strike: 680 }], SETTLE_DELAY_SECS);
    expect(await runSettlement(w.deps())).toMatchObject({ status: "ok", settled: 1 });
    expect(w.executor.sent.length).toBeGreaterThan(0);
  });

  it("follows an early close: due at 13:05 ET, not 16:05", async () => {
    const earlyClose = Date.UTC(2026, 10, 27, 18, 0, 0) / 1000; // 13:00 ET
    const w = new SettleWorld({
      markets: [{ ticker: "META", strike: 680, tradingDate: 20_261_127 }],
      closeTs: earlyClose,
      start: new Date((earlyClose + 299) * 1_000),
      sourceDate: "2026-11-27",
    });
    expect((await runSettlement(w.deps())).status).toBe("idle");
    w.clock.sleep(2_000); // 13:05:01
    expect(await runSettlement(w.deps())).toMatchObject({ status: "ok", settled: 1 });
    expect(w.verifyCalls).toEqual([{ ticker: "META", date: "2026-11-27" }]);
  });
});

describe("runSettlement: settling (AC1, AC4)", () => {
  it("settles every open market of a ticker in one run, one oracle update, update first", async () => {
    const w = world([
      { ticker: "META", strike: 640 },
      { ticker: "META", strike: 680 },
      { ticker: "META", strike: 720 },
    ]);
    const result = await runSettlement(w.deps());
    expect(result).toMatchObject({ status: "ok", settled: 3, attempts: 1 });
    expect(w.open).toEqual([]);
    expect(w.update.requested.map((f) => f.toBase58())).toEqual(
      w.update.feeds.map((f) => f.toBase58()),
    );
    // Across the transactions sent for the ticker, every update instruction came before the first
    // settle_market, and the three markets were each settled once.
    const ixs = w.executor.sent.flatMap((sent) => sent.tx.instructions);
    const firstSettle = ixs.findIndex((ix) => ix.programId.equals(w.program.programId));
    expect(firstSettle).toBeGreaterThan(0);
    expect(ixs.slice(0, firstSettle).every((ix) => !ix.programId.equals(w.program.programId))).toBe(
      true,
    );
    expect(ixs.slice(firstSettle).every((ix) => ix.programId.equals(w.program.programId))).toBe(
      true,
    );
    expect(ixs.slice(firstSettle)).toHaveLength(3);
    expect(w.state.lastSettlement).toMatchObject({ status: "ok", settled: 3 });
  });

  it("handles each ticker and trading date separately", async () => {
    const w = world([
      { ticker: "META", strike: 680 },
      { ticker: "AAPL", strike: 230 },
      { ticker: "META", strike: 700, tradingDate: 20_261_005 },
    ]);
    w.verifyOverride = null;
    // The fake sources only know 2026-10-06; the 10-05 group fails its date check. (The API cap
    // is raised so all three groups fit one run; pacing has its own tests below.)
    const options = { ...w.deps().options, windowMs: 0, maxApiCallsPerRun: 100 };
    const result = await runSettlement(w.deps({ options }));
    expect(result.settled).toBe(2);
    expect(result.failures.map((f) => f.group)).toEqual(["META:2026-10-05"]);
    expect(w.open.map((m) => m.strikeCents)).toEqual([70_000n]);
  });

  it("re-running after success sends nothing (AC3, NFR-05)", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    await runSettlement(w.deps());
    const sent = w.executor.sent.length;
    const verified = w.verifyCalls.length;
    const again = await runSettlement(w.deps());
    expect(again).toMatchObject({ status: "idle", settled: 0 });
    expect(w.executor.sent.length).toBe(sent);
    expect(w.verifyCalls.length).toBe(verified);
  });

  it("forgets a group someone else settled meanwhile (settle_market is permissionless)", async () => {
    const w = world([
      { ticker: "META", strike: 640 },
      { ticker: "META", strike: 680 },
    ]);
    w.sourceDate = "2026-10-05"; // our first attempt fails ...
    expect((await runSettlement(w.deps())).status).toBe("failed");
    expect(w.memory.attempts.get("META:2026-10-06")).toBe(1);
    w.open = []; // ... and someone else settles both markets before the next run
    await w.clock.sleep(RUN_EVERY_MS);
    const calls = w.verifyCalls.length;
    expect(await runSettlement(w.deps())).toMatchObject({ status: "idle", attempts: 0 });
    expect(w.verifyCalls.length).toBe(calls);
    expect(w.memory.attempts.size).toBe(0);
    expect(w.memory.firstFailureMs.size).toBe(0);
  });

  it("alerts once when the payer balance is low, and still settles", async () => {
    const w = world([
      { ticker: "META", strike: 680 },
      { ticker: "AAPL", strike: 230 },
    ]);
    w.balance = 1_000;
    const result = await runSettlement(w.deps());
    expect(result.settled).toBe(2);
    const low = w.alerter.alerts.filter((a) => a.kind === "settlement_low_balance");
    expect(low).toHaveLength(1);
  });
});

describe("runSettlement: the re-update is a fresh update (AC5)", () => {
  it("asks the oracle again at the current slot, and no settle goes out into a stale value", async () => {
    const w = new SettleWorld({
      markets: Array.from({ length: 60 }, (_, i) => ({ ticker: "META", strike: 300 + i })),
      closeTs: CLOSE_TS,
      start: new Date((CLOSE_TS + SETTLE_DELAY_SECS) * 1_000),
    });
    // Record the slot each update was built for; give every build its own instruction copies.
    const slotOf = new WeakMap<object, number>();
    const requestSlots: number[] = [];
    const base = w.adapter();
    const deps = w.deps({
      adapter: {
        kind: base.kind,
        build: async (request) => {
          requestSlots.push(request.slot);
          const built = await base.build(request);
          const ixs = built.ixs.map((ix) => new TransactionInstruction({ ...ix }));
          ixs.forEach((ix) => slotOf.set(ix, request.slot));
          return { ...built, ixs };
        },
      },
    });
    w.executor.advancePerSend = (index) => (index === 1 ? 60 : 1); // a long gap after the first settle
    const result = await runSettlement(deps);
    expect(result.status).toBe("ok");

    // The oracle was asked again, and for a later slot than the first time.
    expect(requestSlots.length).toBeGreaterThan(1);
    expect(requestSlots[1]).toBeGreaterThan((requestSlots[0] ?? 0) + 50);
    // Every settle was sent within the program's 30-slot staleness window of the update that
    // carried the freshest value before it (measured at the slot the settle is sent).
    let updateSlot = 0;
    let slotBeforeSend = 1_000;
    for (const sent of w.executor.sent) {
      if (sent.tx.role === "update") {
        updateSlot = slotOf.get(sent.tx.instructions[0] ?? {}) ?? -1;
        expect(updateSlot).toBeGreaterThan(0);
      } else {
        expect(slotBeforeSend - updateSlot).toBeLessThanOrEqual(30);
      }
      slotBeforeSend = sent.slot;
    }
    expect(w.executor.sent.filter((s) => s.tx.role === "update").length).toBeGreaterThan(1);
  }, 10_000);
});

describe("runSettlement: wrong date, retries and the alert (AC2, AB-03)", () => {
  it("a date mismatch sends no transaction, retries once per run for 15 min, then alerts once", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.sourceDate = "2026-10-05"; // yesterday's close is all the sources have
    const results = await failThroughWindow(w);
    expect(results.every((r) => r.status === "failed" && r.attempts === 1)).toBe(true);
    expect(w.executor.sent).toEqual([]);
    expect(w.update.requested).toEqual([]);
    // One attempt per run, every minute, from close + 5 min to close + 20 min.
    expect(w.verifyCalls).toHaveLength(RETRY_WINDOW_MS / RUN_EVERY_MS + 1);
    expect(w.clock.sleeps.every((ms) => ms === RUN_EVERY_MS)).toBe(true);
    expect(w.clock.ms - at(SETTLE_DELAY_SECS).getTime()).toBe(RETRY_WINDOW_MS);
    // Exactly one alert and one incident, sent by the last run of the window.
    expect(w.alerter.alerts.filter((a) => a.kind === "settlement_failed")).toHaveLength(1);
    expect(w.alerter.alerts[0]?.summary).toContain("after 16 attempts");
    expect(w.incidents).toEqual([{ kind: "settlement_failed", tickers: ["META"] }]);
    expect(w.state.lastSettlement).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("does not alert before the window is over", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.sourceDate = "2026-10-05";
    for (let run = 0; run < RETRY_WINDOW_MS / RUN_EVERY_MS; run += 1) {
      await runSettlement(w.deps());
      await w.clock.sleep(RUN_EVERY_MS);
    }
    expect(w.verifyCalls).toHaveLength(RETRY_WINDOW_MS / RUN_EVERY_MS);
    expect(w.alerter.alerts).toEqual([]);
    expect(w.incidents).toEqual([]);
  });

  it("after the alert, retries quietly every 15 minutes, at most 8 times, with no new alert", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.sourceDate = "2026-10-05";
    await failThroughWindow(w);
    const alerts = w.alerter.alerts.length;
    const incidents = w.incidents.length;
    for (let attempt = 1; attempt <= MAX_QUIET_ATTEMPTS; attempt += 1) {
      // The runs in between make no attempt: no verification, no API calls ...
      await w.clock.sleep(RUN_EVERY_MS);
      const before = w.verifyCalls.length;
      expect((await runSettlement(w.deps())).status).toBe("idle");
      expect(w.verifyCalls.length).toBe(before);
      // ... and 15 minutes after the last attempt there is one quiet attempt, with no new alert.
      await w.clock.sleep(QUIET_RETRY_MS - RUN_EVERY_MS);
      expect((await runSettlement(w.deps())).status).toBe("failed");
      expect(w.verifyCalls.length).toBe(before + 1);
    }
    expect(w.alerter.alerts.length).toBe(alerts);
    expect(w.incidents.length).toBe(incidents);
    // Then it stops: the group is left to the settle-now CLI, with one log line.
    for (let run = 0; run < 3; run += 1) {
      await w.clock.sleep(QUIET_RETRY_MS);
      const after = w.verifyCalls.length;
      expect((await runSettlement(w.deps())).status).toBe("idle");
      expect(w.verifyCalls.length).toBe(after);
    }
    expect(w.logger.lines.filter((l) => l.event === "settlement_gave_up")).toHaveLength(1);
  });

  it("settles on the next quiet attempt once the sources catch up, and forgets the incident", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.sourceDate = "2026-10-05";
    await failThroughWindow(w);
    w.sourceDate = "2026-10-06";
    await w.clock.sleep(QUIET_RETRY_MS);
    expect(await runSettlement(w.deps())).toMatchObject({ status: "ok", settled: 1 });
    expect(w.memory.alerted.size).toBe(0);
    expect(w.memory.quietAttempts.size).toBe(0);
  });

  it("settles on a later run when the sources catch up, with no alert", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.sourceDate = "2026-10-05";
    for (let run = 0; run < 3; run += 1) {
      expect((await runSettlement(w.deps())).status).toBe("failed");
      await w.clock.sleep(RUN_EVERY_MS);
    }
    w.sourceDate = "2026-10-06";
    expect(await runSettlement(w.deps())).toMatchObject({ status: "ok", settled: 1, attempts: 1 });
    expect(w.verifyCalls).toHaveLength(4);
    expect(w.alerter.alerts).toEqual([]);
    expect(w.incidents).toEqual([]);
  });

  it("a sent transaction that fails is retried and eventually reported", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.executor.failWith = () => new Error("blockhash not found https://rpc.example/?k=SECRET");
    const results = await failThroughWindow(w);
    expect(results.every((r) => r.status === "failed")).toBe(true);
    expect(w.alerter.alerts).toHaveLength(1);
    expect(JSON.stringify([w.alerter.alerts, w.logger.lines])).not.toContain("SECRET");
  }, 10_000);

  it("fails clearly when the config pins no feeds for the ticker", async () => {
    const w = world([{ ticker: "MSFT", strike: 440 }]);
    w.closes = { MSFT: 41_500 };
    const result = await runSettlement(w.deps({ options: { ...w.deps().options, windowMs: 0 } }));
    expect(result.failures[0]?.reason).toMatch(/no feeds pinned/);
    expect(w.executor.sent).toEqual([]);
  });
});

describe("checkBalance (startup and before each settle)", () => {
  it("alerts once per low episode and again after a top-up that is drained", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    const deps = w.deps();
    const lows = () => w.alerter.alerts.filter((a) => a.kind === "settlement_low_balance").length;
    w.balance = 10;
    await checkBalance(deps, w.memory);
    await checkBalance(deps, w.memory);
    expect(lows()).toBe(1);
    w.balance = 1_000_000_000; // topped up: the flag resets
    await checkBalance(deps, w.memory);
    expect(w.memory.lowBalanceAlerted).toBe(false);
    w.balance = 10; // drained again: a new alert
    await checkBalance(deps, w.memory);
    expect(lows()).toBe(2);
  });

  it("a balance check that fails does not stop the settlement", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    const deps = w.deps();
    const result = await runSettlement({
      ...deps,
      chain: {
        ...deps.chain,
        balanceLamports: () => Promise.reject(new Error("rpc down https://rpc.example/?k=SECRET")),
      },
    });
    expect(result).toMatchObject({ status: "ok", settled: 1 });
    expect(w.logger.lines.map((l) => l.event)).toContain("balance_check_failed");
    expect(JSON.stringify(w.logger.lines)).not.toContain("SECRET");
  });
});

describe("createSettlementJob", () => {
  it("is a per-minute job bound to the payer", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    const spec = createSettlementJob(w.deps());
    expect(spec).toMatchObject({
      name: "settlement",
      cron: SETTLEMENT_CRON,
      signer: w.payer.publicKey.toBase58(),
    });
    await spec.run();
    expect(w.open).toEqual([]);
  });

  it("formats trading dates", () => {
    expect(isoDate(20_261_006)).toBe("2026-10-06");
  });
});

// ---------------------------------------------------------------------------------------------
// Pacing (#53): sessions not yet closed, rate limits, the per-run data-API cap, cold starts.
// ---------------------------------------------------------------------------------------------

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
const FRI = 20_261_009; // a real session
const SAT = 20_261_010; // no session
const MON = 20_261_012; // a future session
const FRI_CLOSE = Date.UTC(2026, 9, 9, 20, 0, 0) / 1_000; // Fri 16:00 ET (EDT)
const SAT_3PM = new Date("2026-10-10T19:00:00Z"); // Sat 15:00 ET, when the storm was observed

/** Markets for `tickers` × `dates`, all with Friday's close as their (for MON: bogus) close_ts. */
function devnetWorld(
  tickers: readonly string[],
  dates: readonly number[],
  start = SAT_3PM,
  closeTs = FRI_CLOSE,
): SettleWorld {
  const w = new SettleWorld({
    markets: tickers.flatMap((ticker) =>
      dates.map((tradingDate) => ({ ticker, strike: 100, tradingDate })),
    ),
    closeTs,
    start,
    sourceDate: "2026-10-09",
    closes: Object.fromEntries(MAG7.map((t) => [t, 10_000])),
  });
  w.pinned = { ...w.pinned, feeds: Object.fromEntries(MAG7.map((t) => [t, w.update.feeds])) };
  return w;
}

/** Counts oracle updates (each makes the Switchboard oracles fetch both sources once). */
function countingAdapter(w: SettleWorld, kind: "switchboard" | "local" = "switchboard") {
  const base = w.adapter();
  const counter = { builds: 0 };
  const adapter: OracleUpdateAdapter = {
    kind,
    build: (request) => {
      counter.builds += 1;
      return base.build(request);
    },
  };
  return { adapter, counter };
}

const response = (status: number, body = "", headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  text: () => Promise.resolve(body),
});
const always429: HttpGet = () => Promise.resolve(response(429, "Too Many Requests"));
const events = (w: SettleWorld, event: string) => w.logger.lines.filter((l) => l.event === event);

describe("pacing (a): groups without a completed session never reach the data APIs", () => {
  it("a Saturday group and a future-session group make zero data-API calls, logged once each", async () => {
    const w = devnetWorld(["META"], [SAT, MON]);
    for (let run = 0; run < 30; run += 1) {
      const result = await runSettlement(w.deps());
      expect(result).toMatchObject({ status: "idle", attempts: 0, failures: [], deferred: [] });
      expect(result.skipped).toEqual([
        { group: "META:2026-10-10", reason: "not_a_trading_day" },
        { group: "META:2026-10-12", reason: "session_not_closed" },
      ]);
      await w.clock.sleep(RUN_EVERY_MS);
    }
    expect(w.httpCalls).toEqual([]);
    expect(w.verifyCalls).toEqual([]);
    expect(w.executor.sent).toEqual([]);
    expect(w.alerter.alerts).toEqual([]);
    expect(w.state.lastSettlement).toBeNull();
    const skips = events(w, "settle_skipped_no_session");
    expect(skips.map((l) => [l.fields?.group, l.fields?.reason])).toEqual([
      ["META:2026-10-10", "not_a_trading_day"],
      ["META:2026-10-12", "session_not_closed"],
    ]);
  });

  it("a session still running today is skipped even though the market's close_ts has passed", async () => {
    // A market for Tue 2026-10-06 whose close_ts was set to 11:00 ET; it is now 12:00 ET.
    const elevenEt = Date.UTC(2026, 9, 6, 15, 0, 0) / 1_000;
    const w = devnetWorld(["META"], [20_261_006], new Date("2026-10-06T16:00:00Z"), elevenEt);
    expect((await runSettlement(w.deps())).skipped).toEqual([
      { group: "META:2026-10-06", reason: "session_not_closed" },
    ]);
    expect(w.httpCalls).toEqual([]);
  });

  it("the future session is settled normally once its real close + 5 min has passed", async () => {
    const w = devnetWorld(["META"], [SAT, MON]);
    await w.clock.sleep(Date.parse("2026-10-12T20:04:00Z") - w.clock.ms); // Mon 16:04 ET
    expect((await runSettlement(w.deps())).attempts).toBe(0);
    await w.clock.sleep(RUN_EVERY_MS); // Mon 16:05 ET
    w.sourceDate = "2026-10-12";
    const result = await runSettlement(w.deps());
    expect(result).toMatchObject({ status: "ok", settled: 1, attempts: 1 });
    expect(w.verifyCalls).toEqual([{ ticker: "META", date: "2026-10-12" }]);
    // The Saturday demo market is still left alone (an admin settles it by override).
    expect(w.open.map((m) => m.tradingDate)).toEqual([SAT]);
  });

  it("a date outside the checked calendar years is skipped, never guessed", async () => {
    const w = devnetWorld(["META"], [20_270_104], new Date("2027-01-05T00:00:00Z"));
    expect((await runSettlement(w.deps())).skipped).toEqual([
      { group: "META:2027-01-04", reason: "outside_calendar" },
    ]);
    expect(w.httpCalls).toEqual([]);
  });
});

describe("pacing (b): a rate limit backs off across runs", () => {
  it("a 429 stops calls until the backoff elapses, doubling while it persists", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.httpOverride = always429;
    const callsAt: number[] = [];
    for (let minute = 0; minute <= 6; minute += 1) {
      if (minute === 6) {
        w.httpOverride = null; // the source recovers
      }
      const before = w.httpCalls.length;
      const result = await runSettlement(w.deps());
      callsAt.push(w.httpCalls.length - before);
      if (minute === 1) {
        expect(result).toMatchObject({ status: "idle", deferred: ["META:2026-10-06"] });
      }
      if (minute === 6) {
        expect(result).toMatchObject({ status: "ok", settled: 1 });
      }
      await w.clock.sleep(RUN_EVERY_MS);
    }
    // 429 at 0 → wait 2 min; 429 at 2 → wait 4 min; next call at 6 (and only Tiingo is asked
    // while it answers 429: Twelve Data is spared).
    expect(callsAt).toEqual([1, 0, 1, 0, 0, 0, 2]);
    expect(events(w, "settle_rate_limited").map((l) => l.fields?.strikes)).toEqual([1, 2]);
    expect(events(w, "settle_attempt_failed")[0]?.fields?.reason).toMatch(/HTTP 429 from <url>/);
    // One "deferred" line per backoff episode, not one per minute.
    expect(
      events(w, "settle_deferred").filter((l) => l.fields?.reason === "rate_limit_backoff"),
    ).toHaveLength(2);
    expect(w.memory.rateLimitStrikes).toBe(0);
  });

  it("honours Retry-After when it asks for longer than the backoff", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.httpOverride = () => Promise.resolve(response(429, "", { "retry-after": "600" }));
    await runSettlement(w.deps());
    expect(w.httpCalls).toHaveLength(1);
    for (let minute = 1; minute < 10; minute += 1) {
      await w.clock.sleep(RUN_EVERY_MS);
      await runSettlement(w.deps());
    }
    expect(w.httpCalls).toHaveLength(1);
    await w.clock.sleep(RUN_EVERY_MS); // 10 minutes after the 429
    await runSettlement(w.deps());
    expect(w.httpCalls).toHaveLength(2);
  });

  it("a 429 stops the rest of the run: no other group is attempted", async () => {
    const w = devnetWorld(MAG7, [FRI]);
    w.httpOverride = always429;
    const options = { ...w.deps().options, maxApiCallsPerRun: 100 };
    const result = await runSettlement(w.deps({ options }));
    expect(result.attempts).toBe(1);
    expect(result.deferred).toHaveLength(MAG7.length - 1);
    expect(w.httpCalls).toHaveLength(1);
  });

  it("Twelve Data's out-of-credits body (HTTP 200, code 429) backs off too", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    const td429 = JSON.stringify({ code: 429, message: "out of API credits", status: "error" });
    const tiingo = JSON.stringify([{ date: "2026-10-06T00:00:00.000Z", close: "680.00" }]);
    w.httpOverride = (url) =>
      Promise.resolve(response(200, new URL(url).host === "api.tiingo.com" ? tiingo : td429));
    await runSettlement(w.deps());
    await w.clock.sleep(RUN_EVERY_MS);
    await runSettlement(w.deps());
    expect(w.httpCalls).toHaveLength(2); // one attempt, then nothing during the backoff
    expect(w.memory.backoffUntilMs).toBeGreaterThan(w.clock.ms);
  });

  it("a rate limit that persists through the window is still alerted, once", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.httpOverride = always429;
    const results = await failThroughWindow(w);
    // Attempts at minutes 0, 2, 6 and 14 (backoff 2, 4, 8 minutes); the alert at minute 15.
    expect(w.httpCalls).toHaveLength(4);
    expect(results.at(-1)).toMatchObject({ status: "failed", attempts: 0 });
    expect(results.at(-1)?.failures[0]?.reason).toMatch(/HTTP 429/);
    expect(w.alerter.alerts.filter((a) => a.kind === "settlement_failed")).toHaveLength(1);
    expect(w.incidents).toHaveLength(1);
  });
});

type Outcome = "ok" | "429" | "429-body" | "503" | "throw";

describe("pacing (c): data-API calls per run never exceed the cap (property)", () => {
  it("over random group counts, caps, adapters and failure patterns", async () => {
    const dates = [20_261_001, 20_261_002, 20_261_003, 20_261_005, 20_261_006]; // 10-03 is a Saturday
    const groups = MAG7.flatMap((ticker) => dates.map((date) => ({ ticker, date })));
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(groups),
        fc.integer({ min: 4, max: 20 }),
        fc.constantFrom("switchboard" as const, "local" as const),
        fc.array(fc.constantFrom<Outcome>("ok", "ok", "ok", "429", "429-body", "503", "throw"), {
          minLength: 1,
          maxLength: 40,
        }),
        fc.integer({ min: 1, max: 8 }),
        async (chosen, cap, kind, outcomes, runs) => {
          const w = new SettleWorld({
            markets: chosen.map((g) => ({ ticker: g.ticker, strike: 100, tradingDate: g.date })),
            closeTs: CLOSE_TS,
            start: at(SETTLE_DELAY_SECS),
            closes: Object.fromEntries(MAG7.map((t) => [t, 10_000])),
          });
          w.pinned = {
            ...w.pinned,
            feeds: Object.fromEntries(MAG7.map((t) => [t, w.update.feeds])),
          };
          const real = fakeSourcesHttp({ closes: w.closes, date: "2026-10-06" });
          let call = 0;
          w.httpOverride = (url, init) => {
            const outcome = outcomes[call % outcomes.length] ?? "ok";
            call += 1;
            switch (outcome) {
              case "429":
                return Promise.resolve(response(429, "", { "retry-after": "30" }));
              case "429-body":
                return Promise.resolve(
                  response(200, JSON.stringify({ status: "error", code: 429, message: "credits" })),
                );
              case "503":
                return Promise.resolve(response(503));
              case "throw":
                return Promise.reject(new Error("socket hang up"));
              default:
                return real(url, init);
            }
          };
          const { adapter, counter } = countingAdapter(w, kind);
          const perUpdate = kind === "switchboard" ? 2 : 0;
          for (let run = 0; run < runs; run += 1) {
            const http = w.httpCalls.length;
            const builds = counter.builds;
            const verified = w.verifyCalls.length;
            const result = await runSettlement(
              w.deps({ adapter, options: { ...w.deps().options, maxApiCallsPerRun: cap } }),
            );
            const httpThisRun = w.httpCalls.length - http;
            const buildsThisRun = counter.builds - builds;
            expect(httpThisRun + perUpdate * buildsThisRun).toBeLessThanOrEqual(cap);
            // At most one attempt per group per run, and never for a Saturday group.
            const attempted = w.verifyCalls.slice(verified).map((v) => `${v.ticker}:${v.date}`);
            expect(new Set(attempted).size).toBe(attempted.length);
            expect(attempted.length).toBe(result.attempts);
            expect(attempted.every((g) => !g.endsWith("2026-10-03"))).toBe(true);
            await w.clock.sleep(RUN_EVERY_MS);
          }
        },
      ),
      { numRuns: 60 },
    );
  }, 60_000);
});

describe("pacing (d): a normal Friday group still settles on the first successful attempt", () => {
  it("settles Friday's markets on Saturday in one attempt, with one request per source", async () => {
    const w = devnetWorld(["META"], [FRI, SAT, MON]);
    const result = await runSettlement(w.deps());
    expect(result).toMatchObject({ status: "ok", settled: 1, attempts: 1, failures: [] });
    expect(w.verifyCalls).toEqual([{ ticker: "META", date: "2026-10-09" }]);
    expect(w.httpCalls.map((url) => new URL(url).host)).toEqual([
      "api.tiingo.com",
      "api.twelvedata.com",
    ]);
    expect(w.executor.sent.length).toBeGreaterThan(0);
    expect(w.open.map((m) => m.tradingDate).sort()).toEqual([SAT, MON]);
  });
});

describe("pacing (e): a cold start does not burst", () => {
  it("the observed devnet backlog (7 tickers × Fri, Sat, Mon) stays within the cap from the first run", async () => {
    const w = devnetWorld(MAG7, [FRI, SAT, MON]);
    expect(w.open).toHaveLength(21);
    const { adapter, counter } = countingAdapter(w);
    const cap = JOB_OPTIONS.maxApiCallsPerRun;
    let settled = 0;
    let runs = 0;
    while (w.open.some((m) => m.tradingDate === FRI)) {
      const http = w.httpCalls.length;
      const builds = counter.builds;
      const result = await runSettlement(w.deps({ adapter }));
      expect(w.httpCalls.length - http + 2 * (counter.builds - builds)).toBeLessThanOrEqual(cap);
      expect(result.skipped).toHaveLength(14);
      if (runs === 0) {
        expect(w.httpCalls.length).toBeLessThanOrEqual(cap);
        expect(result).toMatchObject({ attempts: 2, settled: 2 });
        expect(result.deferred).toHaveLength(5);
      }
      settled += result.settled;
      runs += 1;
      await w.clock.sleep(RUN_EVERY_MS);
    }
    // The seven Friday groups are spread over four runs; Saturday and Monday are never asked for.
    expect(runs).toBe(4);
    expect(settled).toBe(7);
    expect(w.verifyCalls.every((v) => v.date === "2026-10-09")).toBe(true);
    expect(w.open).toHaveLength(14);
  });

  it("21 groups that are all due and failing are spread across runs, least recently tried first", async () => {
    const tue = new Date((CLOSE_TS + SETTLE_DELAY_SECS) * 1_000);
    const w = devnetWorld(MAG7, [20_261_001, 20_261_002, 20_261_005], tue, CLOSE_TS);
    w.sourceDate = "2026-10-06"; // every group fails its date check
    const cap = JOB_OPTIONS.maxApiCallsPerRun;
    const first = await runSettlement(w.deps());
    expect(w.httpCalls.length).toBeLessThanOrEqual(cap);
    // A failed check is charged 2 of the 4 requests reserved for a devnet attempt, so 3 attempts
    // fit; each made 1 request (Tiingo had no bar, so Twelve Data was not asked).
    expect(first.attempts).toBe(3);
    expect(w.httpCalls).toHaveLength(3);
    const tried = new Set(w.verifyCalls.map((v) => `${v.ticker}:${v.date}`));
    for (let run = 1; run < 7; run += 1) {
      await w.clock.sleep(RUN_EVERY_MS);
      const before = w.httpCalls.length;
      await runSettlement(w.deps());
      expect(w.httpCalls.length - before).toBeLessThanOrEqual(cap);
      w.verifyCalls.forEach((v) => tried.add(`${v.ticker}:${v.date}`));
    }
    expect(tried.size).toBe(21); // every group had its first attempt within 7 runs
    expect(events(w, "settle_deferred")[0]?.fields).toMatchObject({ reason: "api_budget" });
  });
});
