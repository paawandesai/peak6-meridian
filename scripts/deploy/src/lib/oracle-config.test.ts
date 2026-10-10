import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ORACLE_CONFIG,
  ethereumAddressToBytes,
  readOracleConfigFile,
  REDSTONE_PRIMARY_PROD_SIGNERS,
} from "./oracle-config";
import { parseOptions } from "./options";

let tempDir: string | null = null;

beforeEach(async () => {
  const { makeTempDir } = await import("../../test/deploy/harness");
  tempDir = makeTempDir("oracle-config-test");
});

afterEach(async () => {
  if (tempDir !== null) {
    const { removeDir } = await import("../../test/deploy/harness");
    removeDir(tempDir);
    tempDir = null;
  }
});

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

  it("readOracleConfigFile reads a valid temp JSON file", () => {
    if (tempDir === null) throw new Error("tempDir not set");
    const configPath = join(tempDir, "oracle-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        signers: [
          "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
          "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
        ],
        signerThreshold: 2,
        maxPackageDelaySecs: 300,
      }),
    );
    const config = readOracleConfigFile(configPath);
    expect(config.signers).toHaveLength(2);
    // Signers remain as hex strings until conversion
    expect(config.signers[0]).toBe("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
    expect(config.signerThreshold).toBe(2);
    expect(config.maxPackageDelaySecs).toBe(300);
  });

  it("readOracleConfigFile throws when signerThreshold > signers.length", () => {
    if (tempDir === null) throw new Error("tempDir not set");
    const configPath = join(tempDir, "bad-threshold.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        signers: ["0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"],
        signerThreshold: 2,
        maxPackageDelaySecs: 600,
      }),
    );
    expect(() => readOracleConfigFile(configPath)).toThrow(
      "signerThreshold (2) > signers.length (1)",
    );
  });

  it("ethereumAddressToBytes converts a pinned RedStone address correctly", () => {
    // Test with keyrock-1: 0x8cdBF4FE234F106eFB28D84Ef466bBaf8616f8D9
    const bytes = ethereumAddressToBytes("0x8cdBF4FE234F106eFB28D84Ef466bBaf8616f8D9");
    expect(bytes).toHaveLength(20);
    expect(bytes).toEqual([
      0x8c, 0xdb, 0xf4, 0xfe, 0x23, 0x4f, 0x10, 0x6e, 0xfb, 0x28, 0xd8, 0x4e, 0xf4, 0x66, 0xbb,
      0xaf, 0x86, 0x16, 0xf8, 0xd9,
    ]);
  });

  it("parseOptions sets oracleConfigPath when --oracle-config is passed", () => {
    if (tempDir === null) throw new Error("tempDir not set");
    const configPath = join(tempDir, "oracle.json");
    writeFileSync(configPath, "{}");
    const opts = parseOptions(
      {
        SOLANA_RPC_URL: "http://localhost:8899",
        ADMIN_KEYPAIR_PATH: "admin.json",
        PROGRAM_KEYPAIR_PATH: "program.json",
        FAUCET_PUBKEY: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        AUTOMATION_PUBKEY: "11111111111111111111111111111111",
      },
      ["--oracle-config", configPath],
      tempDir,
    );
    if (opts === "help") throw new Error("unexpected help");
    expect(opts.oracleConfigPath).toBe(configPath);
  });
});
