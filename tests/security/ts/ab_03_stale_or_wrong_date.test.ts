// AB-03 · Settle with a stale oracle value or yesterday's close (threat-model.md; NFR-06; M2-04
// AC6). Off-chain: a wrong-date close, or a source that is a day behind, sends NOTHING, and a
// stale on-chain update is never sent into `settle_market`. On-chain (local validator, inside
// `make e2e`): the program itself rejects a value older than `max_staleness_slots`
// (`OracleStale`) and a value produced before `close_ts` (`OracleBeforeClose`).
import { RETRY_WINDOW_MS, runSettlement } from "automation";
import { FakeExecutor, SettleWorld } from "automation/testing";
import { describe, expect, it } from "vitest";

import {
  chainTime,
  createMarket,
  localFeedPda,
  SKIP_REASON,
  setLocalFeed,
  trySettle,
  validatorSession,
  waitUntil,
} from "./validator";

const CLOSE_TS = 1_791_316_800; // 2026-10-06 16:00 ET
const world = () =>
  new SettleWorld({
    markets: [{ ticker: "META", strike: 680 }],
    closeTs: CLOSE_TS,
    start: new Date((CLOSE_TS + 300) * 1_000),
  });

describe("AB-03 off-chain: the wrong date sends nothing", () => {
  it("yesterday's close from both sources: no transaction, no oracle update, one alert after 15 minutes", async () => {
    const w = world();
    w.sourceDate = "2026-10-05";
    // The job runs every minute, one attempt per run (#53): drive it through the window.
    const runEveryMs = 60_000;
    for (let elapsed = 0; elapsed <= RETRY_WINDOW_MS; elapsed += runEveryMs) {
      if (elapsed > 0) {
        await w.clock.sleep(runEveryMs);
      }
      const result = await runSettlement(w.deps());
      expect(result.status).toBe("failed");
      const alerts = w.alerter.alerts.filter((a) => a.kind === "settlement_failed");
      expect(alerts).toHaveLength(elapsed < RETRY_WINDOW_MS ? 0 : 1);
    }
    expect(w.executor.sent).toEqual([]);
    expect(w.update.requested).toEqual([]);
    expect(w.clock.ms - (CLOSE_TS + 300) * 1_000).toBe(RETRY_WINDOW_MS);
    expect(w.alerter.alerts.filter((a) => a.kind === "settlement_failed")).toHaveLength(1);
  });

  it("one source a day behind is as bad as both: nothing is sent", async () => {
    const w = world();
    w.twelveDataDate = "2026-10-05";
    const result = await runSettlement(w.deps());
    expect(result.status).toBe("failed");
    expect(w.executor.sent).toEqual([]);
    expect(result.failures[0]?.reason).toMatch(/missing_bar/);
  });

  it("sources that disagree send nothing", async () => {
    const w = world();
    w.verifyOverride = (ticker, date) => ({
      ok: false,
      error: { kind: "sources_disagree", ticker, date, message: "differ by more than 5 bps" },
    });
    expect((await runSettlement(w.deps())).status).toBe("failed");
    expect(w.executor.sent).toEqual([]);
  });

  it("settles as soon as both sources report the market's own trading date", async () => {
    const w = world();
    expect((await runSettlement(w.deps())).status).toBe("ok");
    expect(w.verifyCalls).toEqual([{ ticker: "META", date: "2026-10-06" }]);
  });
});

describe("AB-03 off-chain: a stale on-chain update is never sent to settle", () => {
  it("when the slots run out between the update and a settle, the update is re-sent first", async () => {
    const w = new SettleWorld({
      markets: Array.from({ length: 60 }, (_, i) => ({ ticker: "META", strike: 300 + i })),
      closeTs: CLOSE_TS,
      start: new Date((CLOSE_TS + 300) * 1_000),
    });
    const executor: FakeExecutor = w.executor;
    executor.advancePerSend = (index) => (index === 1 ? 60 : 1); // a long gap after the first settle
    const result = await runSettlement(w.deps());
    expect(result.status).toBe("ok");
    const sends = executor.sent;
    let updatedAt = 0;
    let previous = 1_000;
    for (const sent of sends) {
      if (sent.tx.role === "update") {
        updatedAt = sent.slot;
      } else {
        // The slot just before this settle was sent (the previous send's slot) is within the
        // 30-slot staleness window of the update (minus the job's safety margin).
        expect(previous - updatedAt).toBeLessThanOrEqual(20);
      }
      previous = sent.slot;
    }
    expect(sends.filter((s) => s.tx.role === "update").length).toBeGreaterThan(1);
  });
});

const v = validatorSession();
describe.runIf(v !== null)(
  "AB-03 on-chain (local validator): the program rejects a stale or too-early value",
  () => {
    it(
      "a value written before close_ts is OracleBeforeClose; one older than the staleness window is OracleStale",
      { timeout: 180_000 },
      async () => {
        if (v === null) {
          throw new Error(SKIP_REASON);
        }
        const { market, closeTs } = await createMarket(v, 20);
        const feeds: [typeof market, typeof market] = [
          localFeedPda(v.programId, "META", 0),
          localFeedPda(v.programId, "META", 1),
        ];
        // Both sources publish BEFORE the close ...
        await setLocalFeed(v, "META", 0, 68_000n, await v.connection.getSlot("confirmed"));
        await setLocalFeed(v, "META", 1, 68_000n, await v.connection.getSlot("confirmed"));
        await waitUntil(v, closeTs);
        expect(await trySettle(v, market, feeds)).toBe("OracleBeforeClose");
        // ... and after the close, a value whose slot is far in the past is stale.
        const slot = await v.connection.getSlot("confirmed");
        await setLocalFeed(v, "META", 0, 68_000n, Math.max(1, slot - 500));
        await setLocalFeed(v, "META", 1, 68_000n, Math.max(1, slot - 500));
        expect(await trySettle(v, market, feeds)).toBe("OracleStale");
        expect(await chainTime(v)).toBeGreaterThanOrEqual(closeTs);
      },
    );
  },
);
describe.skipIf(v !== null)("AB-03 on-chain (local validator)", () => {
  it.skip(SKIP_REASON, () => undefined);
});
