// AB-05 · Settle before close (threat-model.md; NFR-06; M2-04 AC6). Off-chain: the job never
// sends anything before close + 5 minutes, whatever the clock says, early-close days included.
// On-chain (local validator, inside `make e2e`): the program rejects an early `settle_market`
// with `MeridianError::NotClosed`.
import { SETTLE_DELAY_SECS, runSettlement } from "automation";
import { SettleWorld } from "automation/testing";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createMarket, localFeedPda, SKIP_REASON, trySettle, validatorSession } from "./validator";

const CLOSE_TS = 1_791_316_800; // 2026-10-06 16:00 ET
const EARLY_CLOSE_TS = Date.UTC(2026, 10, 27, 18, 0, 0) / 1000; // 2026-11-27 13:00 ET

describe("AB-05 off-chain: the job never sends before close + 5 minutes (fake clock)", () => {
  it("property: any moment before close + 300 s sends nothing; from then on it settles", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -86_400, max: SETTLE_DELAY_SECS + 600 }),
        async (offset) => {
          const w = new SettleWorld({
            markets: [{ ticker: "META", strike: 680 }],
            closeTs: CLOSE_TS,
            start: new Date((CLOSE_TS + offset) * 1_000),
          });
          const result = await runSettlement(w.deps());
          if (offset < SETTLE_DELAY_SECS) {
            expect(result.status).toBe("idle");
            expect(w.executor.sent).toEqual([]);
            expect(w.verifyCalls).toEqual([]);
          } else {
            expect(result.status).toBe("ok");
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it("on an early-close day the 13:05 ET boundary applies, not 16:05", async () => {
    for (const [offset, due] of [
      [299, false],
      [300, true],
    ] as const) {
      const w = new SettleWorld({
        markets: [{ ticker: "META", strike: 680, tradingDate: 20_261_127 }],
        closeTs: EARLY_CLOSE_TS,
        start: new Date((EARLY_CLOSE_TS + offset) * 1_000),
        sourceDate: "2026-11-27",
      });
      expect((await runSettlement(w.deps())).status).toBe(due ? "ok" : "idle");
    }
  });

  it("a market that has not closed is never touched while others settle", async () => {
    const w = new SettleWorld({
      markets: [
        { ticker: "META", strike: 680 },
        { ticker: "META", strike: 700, tradingDate: 20_261_007 },
      ],
      closeTs: CLOSE_TS,
      start: new Date((CLOSE_TS + 300) * 1_000),
    });
    const tomorrow = w.open[1];
    if (tomorrow !== undefined) {
      w.open[1] = { ...tomorrow, closeTs: CLOSE_TS + 86_400 };
    }
    expect((await runSettlement(w.deps())).settled).toBe(1);
    expect(w.open).toHaveLength(1);
    expect(w.open[0]?.closeTs).toBe(CLOSE_TS + 86_400);
  });
});

const v = validatorSession();
describe.runIf(v !== null)(
  "AB-05 on-chain (local validator): the program rejects an early settle_market",
  () => {
    it("settle_market before close_ts fails with NotClosed", async () => {
      if (v === null) {
        throw new Error(SKIP_REASON);
      }
      const { market } = await createMarket(v, 3_600);
      const feeds: [ReturnType<typeof localFeedPda>, ReturnType<typeof localFeedPda>] = [
        localFeedPda(v.programId, "META", 0),
        localFeedPda(v.programId, "META", 1),
      ];
      expect(await trySettle(v, market, feeds)).toBe("NotClosed");
    });
  },
);
describe.skipIf(v !== null)("AB-05 on-chain (local validator)", () => {
  it.skip(SKIP_REASON, () => undefined);
});
