/**
 * M3-07 AC2: FAULT_INJECT_SOURCE is refused on any non-local cluster (AB-style test).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  validateFaultInjection,
  applyFaultOffset,
  FAULT_INJECT_BPS,
} from "../../../scripts/lib/demo/fault-inject";

describe("fault injection validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("allows fault injection on localnet", () => {
    process.env.SOLANA_CLUSTER = "localnet";
    process.env.FAULT_INJECT_SOURCE = "twelvedata";

    const config = validateFaultInjection();

    expect(config.source).toBe("twelvedata");
    expect(config.offsetBps).toBe(FAULT_INJECT_BPS);
  });

  it("allows no fault injection on any cluster", () => {
    process.env.SOLANA_CLUSTER = "devnet";
    delete process.env.FAULT_INJECT_SOURCE;

    const config = validateFaultInjection();

    expect(config.source).toBeUndefined();
    expect(config.offsetBps).toBe(FAULT_INJECT_BPS);
  });

  it("refuses fault injection on devnet", () => {
    process.env.SOLANA_CLUSTER = "devnet";
    process.env.FAULT_INJECT_SOURCE = "tiingo";

    expect(() => validateFaultInjection()).toThrow(/refused on cluster 'devnet'/);
    expect(() => validateFaultInjection()).toThrow(/only allowed on localnet/);
  });

  it("refuses fault injection on mainnet", () => {
    process.env.SOLANA_CLUSTER = "mainnet-beta";
    process.env.FAULT_INJECT_SOURCE = "twelvedata";

    expect(() => validateFaultInjection()).toThrow(/refused on cluster 'mainnet-beta'/);
    expect(() => validateFaultInjection()).toThrow(/only allowed on localnet/);
  });

  it("refuses fault injection on unknown cluster", () => {
    process.env.SOLANA_CLUSTER = "production";
    process.env.FAULT_INJECT_SOURCE = "tiingo";

    expect(() => validateFaultInjection()).toThrow(/refused on cluster 'production'/);
  });

  describe("price offset calculation", () => {
    it("applies positive offset correctly", () => {
      const price = 70000n; // $700.00
      const offset = 200; // 2%
      const result = applyFaultOffset(price, offset);

      expect(result).toBe(71400n); // $714.00 (+2%)
    });

    it("applies negative offset correctly", () => {
      const price = 70000n;
      const offset = -200; // -2%
      const result = applyFaultOffset(price, offset);

      expect(result).toBe(68600n); // $686.00 (-2%)
    });

    it("handles zero offset", () => {
      const price = 70000n;
      const result = applyFaultOffset(price, 0);

      expect(result).toBe(70000n);
    });

    it("rounds down for fractional results", () => {
      const price = 99n; // Will produce fractional offset
      const offset = 33; // 0.33%
      const result = applyFaultOffset(price, offset);

      // 99 * 33 / 10000 = 0.3267, rounds down to 0
      expect(result).toBe(99n);
    });
  });
});
