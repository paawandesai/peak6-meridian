import { describe, expect, it } from "vitest";

import {
  checkBalance,
  MAX_QUIET_ATTEMPTS,
  QUIET_RETRY_MS,
  createSettlementJob,
  isoDate,
  RETRY_EVERY_MS,
  RETRY_WINDOW_MS,
  runSettlement,
  SETTLE_DELAY_SECS,
  SETTLEMENT_CRON,
} from "./settle";
import { TransactionInstruction } from "@solana/web3.js";

import { SettleWorld } from "../testing";

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
    // The fake sources only know 2026-10-06; the 10-05 group fails its date check.
    const result = await runSettlement(w.deps({ options: { ...w.deps().options, windowMs: 0 } }));
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

  it("skips a market someone else settled meanwhile (settle_market is permissionless)", async () => {
    const w = world([
      { ticker: "META", strike: 640 },
      { ticker: "META", strike: 680 },
    ]);
    const settledElsewhere = w.open[0];
    const deps = w.deps();
    let first = true;
    const result = await runSettlement({
      ...deps,
      chain: {
        ...deps.chain,
        openMarkets: async () => {
          const open = await w.chain.openMarkets();
          if (first) {
            first = false;
            return open;
          }
          return open.filter((m) => m !== settledElsewhere);
        },
      },
    });
    expect(result.status).toBe("ok");
    expect(w.executor.sent.length).toBeGreaterThan(0);
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
  it(
    "asks the oracle again at the current slot, and no settle goes out into a stale value",
    async () => {
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
    },
    10_000,
  );
});

describe("runSettlement: wrong date, retries and the alert (AC2, AB-03)", () => {
  it("a date mismatch sends no transaction, retries every 30 s for 15 min, then alerts once", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.sourceDate = "2026-10-05"; // yesterday's close is all the sources have
    const result = await runSettlement(w.deps());
    expect(result.status).toBe("failed");
    expect(w.executor.sent).toEqual([]);
    expect(w.update.requested).toEqual([]);
    // 15 minutes of retries every 30 s.
    expect(w.clock.sleeps.every((ms) => ms === RETRY_EVERY_MS)).toBe(true);
    expect(w.clock.sleeps).toHaveLength(RETRY_WINDOW_MS / RETRY_EVERY_MS);
    expect(result.attempts).toBe(RETRY_WINDOW_MS / RETRY_EVERY_MS + 1);
    expect(w.clock.ms - at(SETTLE_DELAY_SECS).getTime()).toBe(RETRY_WINDOW_MS);
    // Exactly one alert and one incident.
    expect(w.alerter.alerts.filter((a) => a.kind === "settlement_failed")).toHaveLength(1);
    expect(w.incidents).toEqual([{ kind: "settlement_failed", tickers: ["META"] }]);
    expect(w.state.lastSettlement).toMatchObject({ status: "failed" });
    expect(w.state.failures).toHaveLength(1);
  });

  it("after the alert, retries quietly every 15 minutes, at most 8 times, with no new alert", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.sourceDate = "2026-10-05";
    await runSettlement(w.deps());
    const alerts = w.alerter.alerts.length;
    const incidents = w.incidents.length;
    const sleeps = w.clock.sleeps.length;
    // The very next minute's tick does nothing: no verification, no API calls.
    const calls = w.verifyCalls.length;
    expect((await runSettlement(w.deps())).status).toBe("idle");
    expect(w.verifyCalls.length).toBe(calls);
    // Every 15 minutes there is one quiet attempt (no 15-minute wait, no new alert) ...
    for (let attempt = 1; attempt <= MAX_QUIET_ATTEMPTS; attempt += 1) {
      await w.clock.sleep(QUIET_RETRY_MS);
      const before = w.verifyCalls.length;
      expect((await runSettlement(w.deps())).status).toBe("failed");
      expect(w.verifyCalls.length).toBe(before + 1);
    }
    expect(w.clock.sleeps.length).toBe(sleeps + MAX_QUIET_ATTEMPTS);
    expect(w.alerter.alerts.length).toBe(alerts);
    expect(w.incidents.length).toBe(incidents);
    // ... and then it stops: the group is left to the settle-now CLI, with one log line.
    await w.clock.sleep(QUIET_RETRY_MS);
    const after = w.verifyCalls.length;
    expect((await runSettlement(w.deps())).status).toBe("idle");
    expect(w.verifyCalls.length).toBe(after);
    expect(w.logger.lines.filter((l) => l.event === "settlement_gave_up")).toHaveLength(1);
  });

  it("settles on the next quiet attempt once the sources catch up, and forgets the incident", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.sourceDate = "2026-10-05";
    await runSettlement(w.deps());
    w.sourceDate = "2026-10-06";
    await w.clock.sleep(QUIET_RETRY_MS);
    expect(await runSettlement(w.deps())).toMatchObject({ status: "ok", settled: 1 });
    expect(w.memory.alerted.size).toBe(0);
    expect(w.memory.quietAttempts.size).toBe(0);
  });

  it("settles on a later retry when the sources catch up, with no alert", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.sourceDate = "2026-10-05";
    const deps = w.deps();
    let sleeps = 0;
    const result = await runSettlement({
      ...deps,
      sleep: async (ms) => {
        sleeps += 1;
        if (sleeps === 3) {
          w.sourceDate = "2026-10-06";
        }
        await deps.sleep(ms);
      },
    });
    expect(result).toMatchObject({ status: "ok", settled: 1, attempts: 4 });
    expect(w.alerter.alerts).toEqual([]);
    expect(w.incidents).toEqual([]);
  });

  it("a sent transaction that fails is retried and eventually reported", async () => {
    const w = world([{ ticker: "META", strike: 680 }]);
    w.executor.failWith = () => new Error("blockhash not found https://rpc.example/?k=SECRET");
    const result = await runSettlement(w.deps());
    expect(result.status).toBe("failed");
    expect(w.alerter.alerts).toHaveLength(1);
    expect(JSON.stringify([w.alerter.alerts, w.logger.lines])).not.toContain("SECRET");
  });

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
