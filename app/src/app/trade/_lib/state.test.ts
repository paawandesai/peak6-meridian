import { describe, expect, it } from "vitest";

import {
  badgeProps,
  CLOSED_HELP,
  nextTransition,
  panelState,
  PAUSED_REASON,
  settledText,
} from "./state";
import { stateBadgeText } from "@/components/ui";
import type { AppConfig } from "@/lib/chain";
import { formatEtHm } from "@/lib/time";
import { market } from "@/test-utils";

// 2026-10-08 16:00 ET (EDT) = 20:00:00Z
const CLOSE = 1_791_489_600n;
const open = market({ closeTs: CLOSE });
const config: AppConfig = { paused: false, overrideDelaySecs: 3600n, admin: "A" };
const paused: AppConfig = { ...config, paused: true };
const at = (offset: number) => Number(CLOSE) + offset;

describe("panelState (AC7)", () => {
  it("is tradable while Open and Closing soon, with the recovery actions", () => {
    for (const now of [at(-3600), at(-60)]) {
      const state = panelState(open, config, now);
      expect(state.tradable).toBe(true);
      expect(state.allow).toEqual({
        cancel: true,
        withdraw: true,
        pairRedeem: true,
        winnerRedeem: false,
      });
    }
  });

  it("Paused applies to an otherwise open market", () => {
    for (const now of [at(-3600), at(-60)]) {
      expect(panelState(open, paused, now)).toMatchObject({
        tradable: false,
        status: "Paused",
        reason: "Paused: trading and minting stopped; cancel, withdraw and redeem still work",
      });
    }
    expect(PAUSED_REASON).toMatch(/^Paused:/);
  });

  it("Closed names the settling time in ET and carries the help line", () => {
    const state = panelState(open, config, at(1));
    expect(state).toMatchObject({
      status: "Closed",
      reason: "Closed: no new orders; settling at 16:05 ET",
      help: CLOSED_HELP,
    });
    expect(state.tradable).toBe(false);
  });

  it("Settling reads exactly `Settling…` with the help line", () => {
    expect(panelState(open, config, at(5 * 60))).toMatchObject({
      status: "Settling",
      reason: "Settling…",
      help: CLOSED_HELP,
    });
  });

  it("Settlement delayed names the override time before close + delay and `available now` at and after", () => {
    const before = panelState(open, config, at(3599));
    const exactly = panelState(open, config, at(3600));
    const after = panelState(open, config, at(7200));
    const prefix = "Settlement delayed: automatic settlement has stopped; ";
    expect(before).toMatchObject({
      status: "SettlementDelayed",
      reason: `${prefix}an admin override opens at 17:00 ET`,
      help: CLOSED_HELP,
    });
    expect(exactly).toMatchObject({ reason: `${prefix}an admin override is available now` });
    expect(after).toMatchObject({ reason: `${prefix}an admin override is available now` });
  });

  it("follows a changed override delay and an early close (13:00 ET)", () => {
    const early = market({ closeTs: CLOSE - 3n * 3600n });
    const delay: AppConfig = { ...config, overrideDelaySecs: 1800n };
    const now = Number(early.closeTs) + 25 * 60;
    expect(panelState(early, delay, now)).toMatchObject({
      reason:
        "Settlement delayed: automatic settlement has stopped; an admin override opens at 13:30 ET",
    });
    expect(panelState(early, config, Number(early.closeTs) + 1)).toMatchObject({
      reason: "Closed: no new orders; settling at 13:05 ET",
    });
  });

  it("Settled shows the outcome and floored settle price, with winner Redeem and no pair Redeem", () => {
    const settled = market({
      closeTs: CLOSE,
      settled: true,
      outcome: "Yes",
      settlePriceScaled: 181_429_999_999_999_999_999n,
    });
    const state = panelState(settled, config, at(10));
    expect(state).toMatchObject({
      tradable: false,
      status: "Settled",
      reason: "Settled YES at $181.42",
      allow: { cancel: true, withdraw: true, pairRedeem: false, winnerRedeem: true },
    });
    expect(state).not.toHaveProperty("help");
    expect(
      settledText(
        market({ settled: true, outcome: "No", settlePriceScaled: 178_100_000_000_000_000_000n }),
      ),
    ).toBe("Settled NO at $178.10");
  });

  it("precedence: paused + settled is Settled; paused + closed is Closed", () => {
    const settled = market({ closeTs: CLOSE, settled: true });
    expect(panelState(settled, paused, at(10)).status).toBe("Settled");
    expect(panelState(open, paused, at(1))).toMatchObject({
      status: "Closed",
      reason: "Closed: no new orders; settling at 16:05 ET",
    });
  });

  it("every non-tradable state keeps cancel and withdraw, and only Settled lacks pair redeem", () => {
    for (const now of [at(1), at(5 * 60), at(25 * 60)]) {
      expect(panelState(open, config, now).allow).toEqual({
        cancel: true,
        withdraw: true,
        pairRedeem: true,
        winnerRedeem: false,
      });
    }
  });
});

describe("badgeProps", () => {
  it("maps each state to the StateBadge variant", () => {
    const text = (now: number, cfg = config, m = open) => stateBadgeText(badgeProps(m, cfg, now));
    expect(text(at(-3600))).toBe("Open");
    expect(text(at(-60))).toBe("Closes in 01:00");
    expect(text(at(1))).toBe("Closed, settling at 16:05 ET");
    expect(text(at(300))).toBe("Settling…");
    expect(text(at(1300))).toBe(
      "Settlement delayed: automatic settlement has stopped; an admin override opens at 17:00 ET",
    );
    expect(text(at(3600))).toMatch(/available now$/);
    expect(text(at(-3600), paused)).toMatch(/^Paused/);
    expect(text(at(-60), paused)).toMatch(/^Paused/);
    expect(text(at(10), config, market({ closeTs: CLOSE, settled: true }))).toBe(
      "Settled YES at $181.00",
    );
    expect(
      text(
        at(10),
        config,
        market({
          closeTs: CLOSE,
          settled: true,
          outcome: "No",
          settlePriceScaled: 100_000_000_000_000_000_000n,
        }),
      ),
    ).toBe("Settled NO at $100.00");
  });
});

describe("nextTransition (D-050)", () => {
  it("counts down to the next state change", () => {
    expect(nextTransition(open, config, at(-3600))).toEqual({
      label: "Closes in",
      secondsLeft: 3600,
    });
    expect(nextTransition(open, config, at(-60))).toEqual({ label: "Closes in", secondsLeft: 60 });
    expect(nextTransition(open, config, at(100))).toEqual({
      label: "Settling starts in",
      secondsLeft: 200,
    });
    expect(nextTransition(open, config, at(400))).toEqual({
      label: "Settlement delayed in",
      secondsLeft: 800,
    });
    expect(nextTransition(open, config, at(1300))).toEqual({
      label: "Admin override opens in",
      secondsLeft: 2300,
    });
  });

  it("has nothing to wait for once the override is available or the market is settled", () => {
    expect(nextTransition(open, config, at(3600))).toBeNull();
    expect(nextTransition(market({ closeTs: CLOSE, settled: true }), config, at(10))).toBeNull();
  });

  it("formats the settling time through ET, not a fixed offset", () => {
    expect(formatEtHm(CLOSE)).toBe("16:00");
  });
});
