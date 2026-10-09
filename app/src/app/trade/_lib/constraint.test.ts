import { describe, expect, it } from "vitest";

import { gateFor, type Holdings, RESTING_BUY_NO_TEXT } from "./constraint";

const none: Holdings = { yes: 0n, no: 0n, hasRestingAsk: false, escrowedYesFromAsks: false };

describe("gateFor (US-07)", () => {
  it("blocks nothing for a flat wallet", () => {
    for (const intent of ["BUY_YES", "BUY_NO", "SELL_YES", "SELL_NO"] as const) {
      expect(gateFor(intent, none)).toEqual({ blocked: false });
    }
  });

  it("replaces Buy YES with the exit Sell NO when the wallet holds NO", () => {
    expect(gateFor("BUY_YES", { ...none, no: 12n })).toEqual({
      blocked: true,
      kind: "hold-no",
      text: "You hold 12 NO on this strike. Sell NO first to buy YES.",
      exit: "SELL_NO",
      exitLabel: "Sell NO",
      exitQty: 12n,
    });
  });

  it("replaces Buy NO with the exit Sell YES when the wallet holds YES", () => {
    expect(gateFor("BUY_NO", { ...none, yes: 3n })).toMatchObject({
      blocked: true,
      kind: "hold-yes",
      text: "You hold 3 YES on this strike. Sell YES first to buy NO.",
      exit: "SELL_YES",
      exitLabel: "Sell YES",
      exitQty: 3n,
    });
  });

  it("never blocks the exits or the same side", () => {
    const both = { yes: 5n, no: 5n, hasRestingAsk: false, escrowedYesFromAsks: false };
    expect(gateFor("SELL_YES", both).blocked).toBe(false);
    expect(gateFor("SELL_NO", both).blocked).toBe(false);
    expect(gateFor("BUY_YES", { ...none, yes: 5n }).blocked).toBe(false);
    expect(gateFor("BUY_NO", { ...none, no: 5n }).blocked).toBe(false);
  });

  it("explains a resting limit Buy NO (YES escrowed, NO held) instead of offering an exit", () => {
    expect(
      gateFor("BUY_YES", { yes: 0n, no: 10n, hasRestingAsk: true, escrowedYesFromAsks: true }),
    ).toEqual({
      blocked: true,
      kind: "resting-buy-no",
      text: RESTING_BUY_NO_TEXT,
      exit: null,
      exitLabel: null,
      exitQty: 0n,
    });
    expect(RESTING_BUY_NO_TEXT).toBe(
      "Your limit Buy NO is resting; you hold YES in escrow until it fills.",
    );
  });

  it("does not apply the Buy-NO exception when holding NO without a resting Ask", () => {
    // Holding NO without a resting Ask triggers normal hold-NO constraint.
    expect(
      gateFor("BUY_YES", { yes: 0n, no: 10n, hasRestingAsk: false, escrowedYesFromAsks: false }),
    ).toEqual({
      blocked: true,
      kind: "hold-no",
      text: "You hold 10 NO on this strike. Sell NO first to buy YES.",
      exit: "SELL_NO",
      exitLabel: "Sell NO",
      exitQty: 10n,
    });
  });

  it("blocks Buy NO when holding escrowed YES, instructs to cancel asks (AC3)", () => {
    // When wallet YES === 0 but escrowed in resting asks, cannot Sell YES (tokens on book).
    // User must cancel the resting asks first (AC3 / UI-04 AC2).
    expect(
      gateFor("BUY_NO", { yes: 0n, no: 0n, hasRestingAsk: false, escrowedYesFromAsks: true }),
    ).toEqual({
      blocked: true,
      kind: "hold-yes",
      text: "Your YES tokens are escrowed in resting asks. Cancel those orders first.",
      exit: null,
      exitLabel: null,
      exitQty: 0n,
    });
  });

  it("blocks Buy NO when holding wallet YES, offers Sell YES exit", () => {
    // When YES is in wallet (not escrowed), the exit is Sell YES.
    expect(
      gateFor("BUY_NO", { yes: 5n, no: 0n, hasRestingAsk: false, escrowedYesFromAsks: false }),
    ).toEqual({
      blocked: true,
      kind: "hold-yes",
      text: "You hold 5 YES on this strike. Sell YES first to buy NO.",
      exit: "SELL_YES",
      exitLabel: "Sell YES",
      exitQty: 5n,
    });
  });
});
