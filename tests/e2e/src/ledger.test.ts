import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Ledger, UNITS_PER_CENT, UNITS_PER_USDC } from "./ledger";

const price = fc.bigInt({ min: 1n, max: 99n });
const qty = fc.bigInt({ min: 1n, max: 1_000n });

function total(ledger: Ledger, names: readonly string[]) {
  return names.reduce(
    (sum, name) => {
      const h = ledger.get(name);
      return { cash: sum.cash + h.cash, yes: sum.yes + h.yes, no: sum.no + h.no };
    },
    { cash: 0n, yes: 0n, no: 0n },
  );
}

describe("Ledger (the independent model behind M1-10 AC3)", () => {
  it("a trade moves cash and YES between two traders and creates nothing", () => {
    fc.assert(
      fc.property(price, qty, (p, n) => {
        const ledger = new Ledger(["a", "b"]);
        ledger.trade("a", "b", p, n);
        expect(ledger.get("a")).toEqual({ cash: -n * p * UNITS_PER_CENT, yes: n, no: 0n });
        expect(total(ledger, ["a", "b"])).toEqual({ cash: 0n, yes: 0n, no: 0n });
      }),
    );
  });

  it("minting pairs and redeeming them again is a round trip", () => {
    fc.assert(
      fc.property(qty, (n) => {
        const ledger = new Ledger(["a"]);
        ledger.mintPairs("a", n);
        expect(ledger.get("a")).toEqual({ cash: -n * UNITS_PER_USDC, yes: n, no: n });
        ledger.redeemPairs("a", n);
        expect(ledger.get("a")).toEqual({ cash: 0n, yes: 0n, no: 0n });
      }),
    );
  });

  it("settlement pays 1 USDC per winning token, so the winners' payout equals the pairs' collateral", () => {
    fc.assert(
      fc.property(qty, qty, price, fc.boolean(), (minted, sold, p, yesWins) => {
        const sale = sold > minted ? minted : sold;
        const ledger = new Ledger(["a", "b"]);
        ledger.mintPairs("a", minted);
        ledger.trade("b", "a", p, sale);
        const cashBefore = total(ledger, ["a", "b"]).cash;
        expect(cashBefore).toBe(-minted * UNITS_PER_USDC);
        ledger.redeemWinners("a", yesWins);
        ledger.redeemWinners("b", yesWins);
        // Everyone is flat afterwards and the traders together get back exactly the collateral.
        expect(total(ledger, ["a", "b"])).toEqual({ cash: 0n, yes: 0n, no: 0n });
      }),
    );
  });

  it("rejects unknown traders", () => {
    expect(() => new Ledger(["a"]).mintPairs("zed", 1n)).toThrow(/unknown trader/);
  });
});
