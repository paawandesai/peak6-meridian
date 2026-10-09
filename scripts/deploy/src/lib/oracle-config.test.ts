import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORACLE_CONFIG,
  ethereumAddressToBytes,
  readOracleConfigFile,
  REDSTONE_PRIMARY_PROD_SIGNERS,
} from "./oracle-config";

describe("oracle-config (M2-15b)", () => {
  it("DEFAULT_ORACLE_CONFIG has 5 signers with threshold 3", () => {
    expect(DEFAULT_ORACLE_CONFIG.signers).toHaveLength(5);
    expect(DEFAULT_ORACLE_CONFIG.signerThreshold).toBe(3);
    expect(DEFAULT_ORACLE_CONFIG.maxPackageDelaySecs).toBe(600);
  });

  it("REDSTONE_PRIMARY_PROD_SIGNERS are valid Ethereum addresses", () => {
    for (const signer of REDSTONE_PRIMARY_PROD_SIGNERS) {
      expect(signer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("ethereumAddressToBytes converts hex to 20-byte array", () => {
    const bytes = ethereumAddressToBytes("0x1234567890123456789012345678901234567890");
    expect(bytes).toHaveLength(20);
    expect(bytes[0]).toBe(0x12);
    expect(bytes[1]).toBe(0x34);
    expect(bytes[19]).toBe(0x90);
  });

  it("readOracleConfigFile throws on invalid JSON", () => {
    expect(() => readOracleConfigFile("/dev/null")).toThrow("invalid JSON");
  });
});
