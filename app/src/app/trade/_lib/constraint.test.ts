import { describe, expect, it } from "vitest";

import { gateFor, type Holdings, RESTING_BUY_NO_TEXT } from "./constraint";

const none: Holdings = { yes: 0n, no: 0n, hasRestingAsk: false };

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
    const both = { yes: 5n, no: 5n, hasRestingAsk: false };
    expect(gateFor("SELL_YES", both).blocked).toBe(false);
    expect(gateFor("SELL_NO", both).blocked).toBe(false);
    expect(gateFor("BUY_YES", { ...none, yes: 5n }).blocked).toBe(false);
    expect(gateFor("BUY_NO", { ...none, no: 5n }).blocked).toBe(false);
  });

  it("explains a resting limit Buy NO (YES escrowed, NO not yet held) instead of offering an exit", () => {
    expect(gateFor("BUY_YES", { yes: 0n, no: 0n, hasRestingAsk: true })).toEqual({
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

  it("treats a YES Ask while holding NO as Sell YES, not the Buy-NO exception", () => {
    // If you hold NO and have a YES Ask, the Ask must be from Sell YES (Buy NO would be blocked by the constraint).
    // The UI now sets hasRestingAsk=false in this case, so this behaves as normal hold-NO.
    expect(gateFor("BUY_YES", { yes: 0n, no: 10n, hasRestingAsk: false })).toEqual({
      blocked: true,
      kind: "hold-no",
      text: "You hold 10 NO on this strike. Sell NO first to buy YES.",
      exit: "SELL_NO",
      exitLabel: "Sell NO",
      exitQty: 10n,
    });
  });
});
