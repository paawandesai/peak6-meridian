import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { costStrip, payoffSentence, simulationLine, summarize } from "./summary";
import { fills, USER } from "./test-support";
import type { Intent } from "@meridian/client";

const facts = { ticker: "NVDA", strikeCents: 18_000n };
const user = USER.toBase58();

function run(
  intent: Intent,
  kind: "limit" | "ioc",
  priceCents: number,
  qty: bigint,
  pairs: [number, number][],
) {
  return summarize({ intent, kind, priceCents, qty, events: fills(...pairs), user });
}

describe("summarize", () => {
  it("counts only the user's own fills and sums them in the intent's terms", () => {
    const other = summarize({
      intent: "BUY_NO",
      kind: "ioc",
      priceCents: 99,
      qty: 10n,
      events: fills([62, 6], [61, 4]),
      user: "SomeoneElse",
    });
    expect(other.filledQty).toBe(0n);
    const own = run("BUY_NO", "ioc", 99, 10n, [
      [62, 6],
      [61, 4],
    ]);
    // NO price = 100 − YES price: 6 × 38 + 4 × 39
    expect(own.fillCents).toBe(6n * 38n + 4n * 39n);
    expect(own.levels).toEqual([
      { price: 38, yesPrice: 62, qty: 6n },
      { price: 39, yesPrice: 61, qty: 4n },
    ]);
  });

  it("merges fills at the same price and rests the unfilled part of a limit only", () => {
    const limit = run("BUY_YES", "limit", 61, 10n, [
      [61, 4],
      [61, 2],
    ]);
    expect(limit.levels).toEqual([{ price: 61, yesPrice: 61, qty: 6n }]);
    expect(limit.restingQty).toBe(4n);
    expect(limit.restingCents).toBe(4n * 61n);
    expect(limit.contracts).toBe(10n);
    const ioc = run("BUY_YES", "ioc", 99, 10n, [[61, 6]]);
    expect(ioc.restingQty).toBe(0n);
    expect(ioc.contracts).toBe(6n);
  });

  it("has no contracts when nothing fills or rests", () => {
    expect(run("SELL_NO", "ioc", 1, 5n, []).contracts).toBe(0n);
  });
});

describe("the four intents (AC9 labels and amounts)", () => {
  it("Buy YES: pay, win, profit and max loss", () => {
    const s = run("BUY_YES", "ioc", 99, 10n, [[38, 10]]);
    expect(payoffSentence(s, facts)).toBe(
      "You pay $3.80 for 10 contracts. You win $10.00 (profit $6.20) if NVDA closes at or above $180 today. Max loss $3.80.",
    );
    expect(costStrip(s)).toEqual([
      { label: "You pay", value: "$3.80" },
      { label: "Pays if right", value: "$10.00" },
      { label: "Profit if right", value: "$6.20" },
      { label: "Fees", value: "$0.00" },
    ]);
    expect(simulationLine(s)).toBe("Simulated: fills 10 at 38¢ YES. 1 signature.");
  });

  it("Buy NO: the NO price is 100 − the YES bid", () => {
    const s = run("BUY_NO", "ioc", 99, 10n, [[62, 10]]);
    expect(payoffSentence(s, facts)).toBe(
      "You pay $3.80 for 10 contracts. You win $10.00 (profit $6.20) if NVDA closes below $180 today. Max loss $3.80.",
    );
    expect(costStrip(s)[0]).toEqual({ label: "You pay", value: "$3.80" });
    expect(simulationLine(s)).toBe("Simulated: fills 10 at 38¢ NO (62¢ YES bid). 1 signature.");
  });

  it("Sell YES: proceeds are N × p¢ and the strip says what is given up", () => {
    const s = run("SELL_YES", "ioc", 1, 10n, [[42, 10]]);
    expect(payoffSentence(s, facts)).toBe(
      "You receive $4.20 for selling 10 YES contracts. You give up $10.00 if NVDA closes at or above $180 today.",
    );
    expect(costStrip(s)).toEqual([
      { label: "You receive", value: "$4.20" },
      { label: "Gives up if right", value: "$10.00" },
      { label: "Fees", value: "$0.00" },
    ]);
    expect(simulationLine(s)).toBe("Simulated: fills 10 at 42¢ YES. 1 signature.");
  });

  it("Sell NO: net proceeds at the NO price", () => {
    const s = run("SELL_NO", "ioc", 1, 10n, [[58, 10]]);
    expect(costStrip(s)[0]).toEqual({ label: "You receive", value: "$4.20" });
    expect(payoffSentence(s, facts)).toBe(
      "You receive $4.20 for selling 10 NO contracts. You give up $10.00 if NVDA closes below $180 today.",
    );
    expect(simulationLine(s)).toBe("Simulated: fills 10 at 42¢ NO (58¢ YES ask). 1 signature.");
  });

  it("uses the singular for one contract", () => {
    const s = run("BUY_YES", "ioc", 99, 1n, [[60, 1]]);
    expect(payoffSentence(s, facts)).toContain("for 1 contract.");
  });

  it("every figure in the strip equals the one in the sentence (property)", () => {
    const intents: Intent[] = ["BUY_YES", "BUY_NO", "SELL_YES", "SELL_NO"];
    fc.assert(
      fc.property(
        fc.constantFrom(...intents),
        fc.array(fc.tuple(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 50 })), {
          minLength: 1,
          maxLength: 4,
        }),
        (intent, pairs) => {
          const qty = BigInt(pairs.reduce((sum, [, q]) => sum + q, 0));
          const s = run(intent, "ioc", 50, qty, pairs);
          const sentence = payoffSentence(s, facts);
          for (const item of costStrip(s).filter((i) => i.label !== "Fees")) {
            expect(sentence).toContain(item.value);
          }
        },
      ),
    );
  });
});

describe("simulationLine", () => {
  it("reports the volume-weighted average rounded down and the levels", () => {
    const s = run("BUY_NO", "ioc", 99, 10n, [
      [62, 6],
      [61, 4],
    ]);
    // (6 × 38 + 4 × 39) / 10 = 38.4
    expect(simulationLine(s)).toBe(
      "Simulated: fills 10 at an average 38.4¢ NO across 2 prices (YES bids 62¢ ×6, 61¢ ×4). 1 signature.",
    );
  });

  it("never overstates an average that is not a whole tenth", () => {
    const s = run("BUY_YES", "ioc", 99, 3n, [
      [10, 1],
      [11, 1],
      [11, 1],
    ]);
    // 32 / 3 = 10.666…¢ → 10.6¢ (rounded down)
    expect(simulationLine(s)).toContain(
      "an average 10.6¢ YES across 2 prices (YES asks 10¢ ×1, 11¢ ×2)",
    );
  });

  it("describes a resting remainder as the YES order it becomes", () => {
    expect(simulationLine(run("BUY_NO", "limit", 40, 10n, []))).toBe(
      "Simulated: rests YES ask at 60¢. 1 signature.",
    );
    expect(simulationLine(run("BUY_YES", "limit", 40, 10n, []))).toBe(
      "Simulated: rests YES bid at 40¢. 1 signature.",
    );
    expect(simulationLine(run("SELL_YES", "limit", 70, 10n, []))).toBe(
      "Simulated: rests YES ask at 70¢. 1 signature.",
    );
    expect(simulationLine(run("BUY_YES", "limit", 61, 10n, [[61, 4]]))).toBe(
      "Simulated: fills 4 at 61¢ YES; rests 6 as YES bid at 61¢. 1 signature.",
    );
  });

  it("a resting limit is costed at its limit price", () => {
    const s = run("BUY_NO", "limit", 40, 10n, []);
    expect(s.totalCents).toBe(400n);
    expect(payoffSentence(s, facts)).toContain(
      "You pay $4.00 for 10 contracts. You win $10.00 (profit $6.00)",
    );
  });
});
