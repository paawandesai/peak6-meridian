// @vitest-environment node
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  FEE_SOL_LAMPORTS,
  FEE_SOL_THRESHOLD_LAMPORTS,
  faucetSuccessSchema,
  formatLamportsAsSol,
} from "./response";

describe("fee SOL constants", () => {
  it("send more than the threshold, so a funded wallet is not funded again", () => {
    expect(FEE_SOL_LAMPORTS).toBe(10_000_000n);
    expect(FEE_SOL_THRESHOLD_LAMPORTS).toBe(5_000_000n);
    expect(FEE_SOL_LAMPORTS).toBeGreaterThan(FEE_SOL_THRESHOLD_LAMPORTS);
  });
});

describe("formatLamportsAsSol", () => {
  it("formats known values without trailing zeros", () => {
    expect(formatLamportsAsSol(10_000_000n)).toBe("0.01 SOL");
    expect(formatLamportsAsSol(0n)).toBe("0 SOL");
    expect(formatLamportsAsSol(1n)).toBe("0.000000001 SOL");
    expect(formatLamportsAsSol(1_500_000_000n)).toBe("1.5 SOL");
    expect(() => formatLamportsAsSol(-1n)).toThrow(RangeError);
  });

  it("round-trips to the same lamports (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (lamports) => {
        const text = formatLamportsAsSol(lamports).replace(/ SOL$/, "");
        const [whole = "0", fraction = ""] = text.split(".");
        expect(BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"))).toBe(lamports);
      }),
    );
  });
});

describe("faucetSuccessSchema", () => {
  it("accepts the three fee SOL states and rejects anything else", () => {
    const base = { signature: "s", amount_base_units: "1", fee_sol_lamports: "0" };
    for (const status of ["sent", "not_needed", "faucet_low"]) {
      expect(faucetSuccessSchema.safeParse({ ...base, fee_sol_status: status }).success).toBe(true);
    }
    expect(faucetSuccessSchema.safeParse({ ...base, fee_sol_status: "maybe" }).success).toBe(false);
    expect(
      faucetSuccessSchema.safeParse({ ...base, fee_sol_status: "sent", fee_sol_lamports: "-1" })
        .success,
    ).toBe(false);
    expect(faucetSuccessSchema.safeParse({ signature: "s", amount_base_units: "1" }).success).toBe(
      false,
    );
  });
});
