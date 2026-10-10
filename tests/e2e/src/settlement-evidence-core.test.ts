import { describe, expect, it } from "vitest";

import {
  type Evidence,
  explorerTx,
  formatLatency,
  judge,
  latencySecs,
  renderEvidence,
  SETTLEMENT_BUDGET_SECS,
  type SettlementRow,
  withinBudget,
} from "./settlement-evidence-core";

const CLOSE = 1_791_000_000;
const row = (over: Partial<SettlementRow> = {}): SettlementRow => ({
  label: "META $680",
  market: "Mkt1",
  closeTs: CLOSE,
  settledAt: CLOSE + 305,
  signature: "SIG1",
  outcome: "YES",
  ...over,
});
const redeem = { label: "META $680", signature: "RSIG", wallet: "Wallet1" };

describe("settlement latency against the 10-minute budget", () => {
  it("is settled_ts − close_ts; 600 s is inside, 601 s is not", () => {
    expect(latencySecs(row())).toBe(305);
    expect(withinBudget(row({ settledAt: CLOSE + SETTLEMENT_BUDGET_SECS }))).toBe(true);
    expect(withinBudget(row({ settledAt: CLOSE + SETTLEMENT_BUDGET_SECS + 1 }))).toBe(false);
  });

  it("an unknown settle time or a settle before close is never within budget", () => {
    expect(latencySecs(row({ settledAt: null }))).toBeNull();
    expect(withinBudget(row({ settledAt: null }))).toBe(false);
    expect(withinBudget(row({ settledAt: CLOSE - 1 }))).toBe(false);
  });

  it("formats minutes and seconds", () => {
    expect(formatLatency(305)).toBe("5m05s");
    expect(formatLatency(600)).toBe("10m00s");
    expect(formatLatency(-4)).toBe("0m00s");
  });
});

describe("judge", () => {
  const ok: Evidence = { rows: [row()], redeems: [redeem], cluster: "devnet" };

  it("passes with every market settled in budget and a redeem recorded", () => {
    expect(judge(ok)).toEqual({ ok: true, problems: [] });
  });

  it("names every shortfall: unsettled, slow, no markets, no redeem", () => {
    const result = judge({
      rows: [
        row({ label: "A", signature: null, settledAt: null, outcome: null }),
        row({ label: "B", settledAt: CLOSE + 900 }),
      ],
      redeems: [],
      cluster: "devnet",
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      "A: not settled (no MarketSettled event)",
      "B: settled 15m00s after close, over the 10m00s budget",
      "no redeem transaction recorded",
    ]);
    expect(judge({ rows: [], redeems: [redeem], cluster: "devnet" }).problems).toEqual([
      "no markets found for the date",
    ]);
  });
});

describe("the docs/log.md entry", () => {
  it("links every signature on the devnet explorer", () => {
    expect(explorerTx("SIG1", "devnet")).toBe("https://explorer.solana.com/tx/SIG1?cluster=devnet");
    expect(explorerTx("SIG1", "localnet")).toBe("SIG1");
    const text = renderEvidence(
      { rows: [row()], redeems: [redeem], cluster: "devnet" },
      { who: "ops", date: "2026-10-09", screenCapture: ["captures/settled.png"] },
    );
    expect(text).toContain("### Recorded settlement · 2026-10-09 · PASS");
    expect(text).toContain(
      "META $680 (Mkt1): YES, settled 5m05s after close, https://explorer.solana.com/tx/SIG1?cluster=devnet",
    );
    expect(text).toContain(
      "Redeem META $680 by Wallet1: https://explorer.solana.com/tx/RSIG?cluster=devnet",
    );
    expect(text).toContain("Screen captures: captures/settled.png.");
    expect(text).not.toContain("Open items");
  });

  it("is INCOMPLETE and lists the open items when evidence is missing", () => {
    const text = renderEvidence(
      {
        rows: [row({ signature: null, settledAt: null, outcome: null })],
        redeems: [],
        cluster: "devnet",
      },
      { who: "ops", date: "2026-10-09", screenCapture: [] },
    );
    expect(text).toContain("· INCOMPLETE");
    expect(text).toContain("not settled, latency n/a");
    expect(text).toContain("Screen captures: none recorded.");
    expect(text).toContain(
      "Open items: META $680: not settled (no MarketSettled event); no redeem transaction recorded.",
    );
  });
});
