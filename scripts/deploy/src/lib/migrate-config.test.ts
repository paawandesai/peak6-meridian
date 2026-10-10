import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PublicKey } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  classifyConfigAccount,
  CONFIG_V1_LEN,
  CONFIG_V2_LEN,
  decodeConfigPrefix,
  DEFAULT_MIGRATION_MAX_AGE_SECS,
  expectedPythTail,
  MAG7_PYTH_FEED_IDS,
  parseMigrateOptions,
  PYTH_TAIL_LEN,
  rentTopUp,
  verifyMigrated,
} from "./migrate-config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PROGRAM_ID = new PublicKey("H8SBU6m8sGRvKudUGhroDP4oEMyvF9QDhVc9wTFESXSm");

/** The recorded devnet v1 Config (programs/meridian/tests/fixtures/config). */
function devnetV1(): Uint8Array {
  const path = resolve(repoRoot, "programs/meridian/tests/fixtures/config/config_v1_devnet.json");
  const json = JSON.parse(readFileSync(path, "utf8")) as { account: { data: [string, string] } };
  return Uint8Array.from(Buffer.from(json.account.data[0], "base64"));
}

function grow(v1: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(CONFIG_V2_LEN);
  out.set(v1, 0);
  out.set(tail, CONFIG_V1_LEN);
  return out;
}

const signer = new PublicKey("6cp7ExvkgtdQuMyJXv26wg8Z2MBJT2idPdTkXx13F5Se");
const pyth = { lazerSigner: signer, feedIds: [...MAG7_PYTH_FEED_IDS], maxAgeSecs: 30n };
const baseEnv = {
  SOLANA_RPC_URL: "http://127.0.0.1:8999",
  SOLANA_CLUSTER: "localnet",
  ADMIN_KEYPAIR_PATH: "keys/admin.json",
};

describe("parseMigrateOptions", () => {
  it("defaults to no Pyth fields, not a dry run, and resolves the key path against the repo", () => {
    const options = parseMigrateOptions(baseEnv, "/repo");
    expect(options.pyth).toBeNull();
    expect(options.dryRun).toBe(false);
    expect(options.adminKeypairPath).toBe("/repo/keys/admin.json");
    expect(options.solanaCluster).toBe("localnet");
    expect(options.programId).toBeUndefined();
  });

  it("reads DRY_RUN, the program id and the Pyth fields with MAG7 defaults", () => {
    const options = parseMigrateOptions(
      {
        ...baseEnv,
        DRY_RUN: "1",
        MERIDIAN_PROGRAM_ID: PROGRAM_ID.toBase58(),
        PYTH_LAZER_SIGNER: signer.toBase58(),
      },
      "/repo",
    );
    expect(options.dryRun).toBe(true);
    expect(options.programId?.equals(PROGRAM_ID)).toBe(true);
    expect(options.pyth?.feedIds).toEqual(MAG7_PYTH_FEED_IDS);
    expect(options.pyth?.maxAgeSecs).toBe(DEFAULT_MIGRATION_MAX_AGE_SECS);
    expect(options.pyth?.lazerSigner.equals(signer)).toBe(true);
    for (const value of ["true", "YES"]) {
      expect(parseMigrateOptions({ ...baseEnv, DRY_RUN: value }, "/r").dryRun).toBe(true);
    }
    expect(parseMigrateOptions({ ...baseEnv, DRY_RUN: "0" }, "/r").dryRun).toBe(false);
  });

  it("accepts explicit feed ids and max age", () => {
    const options = parseMigrateOptions(
      {
        ...baseEnv,
        PYTH_LAZER_SIGNER: signer.toBase58(),
        PYTH_FEED_IDS: "1, 2,3,4,5,6,4294967295",
        PYTH_MAX_AGE_SECS: "45",
      },
      "/repo",
    );
    expect(options.pyth?.feedIds).toEqual([1, 2, 3, 4, 5, 6, 4_294_967_295]);
    expect(options.pyth?.maxAgeSecs).toBe(45n);
  });

  it("rejects a missing or bad environment and Pyth options without a signer", () => {
    expect(() => parseMigrateOptions({}, "/r")).toThrow(/SOLANA_RPC_URL.*ADMIN_KEYPAIR_PATH/);
    expect(() => parseMigrateOptions({ ...baseEnv, SOLANA_CLUSTER: "mainnet" }, "/r")).toThrow(
      /SOLANA_CLUSTER/,
    );
    expect(() => parseMigrateOptions({ ...baseEnv, PYTH_LAZER_SIGNER: "nope" }, "/r")).toThrow(
      /base58/,
    );
    expect(() => parseMigrateOptions({ ...baseEnv, PYTH_MAX_AGE_SECS: "30" }, "/r")).toThrow(
      /need PYTH_LAZER_SIGNER/,
    );
    const withSigner = { ...baseEnv, PYTH_LAZER_SIGNER: signer.toBase58() };
    expect(() => parseMigrateOptions({ ...withSigner, PYTH_FEED_IDS: "1,2,3" }, "/r")).toThrow(
      /7 ids/,
    );
    expect(() =>
      parseMigrateOptions({ ...withSigner, PYTH_FEED_IDS: "1,2,3,4,5,6,4294967296" }, "/r"),
    ).toThrow(/u32/);
    expect(() =>
      parseMigrateOptions({ ...withSigner, PYTH_FEED_IDS: "1,2,3,4,5,6,-1" }, "/r"),
    ).toThrow(/u32/);
    for (const age of ["0", "-5", "1.5", "9223372036854775808"]) {
      expect(() => parseMigrateOptions({ ...withSigner, PYTH_MAX_AGE_SECS: age }, "/r")).toThrow(
        /positive integer/,
      );
    }
  });
});

describe("the recorded devnet v1 account", () => {
  it("classifies as v1 and decodes its prefix", () => {
    const data = devnetV1();
    expect(data.length).toBe(CONFIG_V1_LEN);
    expect(classifyConfigAccount(data, PROGRAM_ID, PROGRAM_ID)).toBe("v1");
    const prefix = decodeConfigPrefix(data);
    expect(prefix.admin.toBase58()).toBe("6cp7ExvkgtdQuMyJXv26wg8Z2MBJT2idPdTkXx13F5Se");
    expect(prefix.automationAuthority.toBase58()).toBe(
      "7JFyYPJyhJokQ3wMKHwJwb35MFj87snz52nTUS6qeEMy",
    );
    expect(prefix.usdcMint.toBase58()).toBe("GKuoE1akZCNnA4ouVdB6P3ngSnanBM28oydPS54fSnT5");
    expect(prefix.paused).toBe(false);
    expect(prefix.maxStalenessSlots).toBe(30n);
    expect(prefix.maxConfBps).toBe(5);
    expect(prefix.overrideDelaySecs).toBe(3_600n);
    expect(prefix.bump).toBe(254);
  });

  it("verifies cleanly after a correct migration, with or without Pyth fields", () => {
    const v1 = devnetV1();
    for (const fields of [null, pyth]) {
      const after = grow(v1, expectedPythTail(fields));
      expect(classifyConfigAccount(after, PROGRAM_ID, PROGRAM_ID)).toBe("v2");
      expect(decodeConfigPrefix(after)).toEqual(decodeConfigPrefix(v1));
      expect(
        verifyMigrated({ before: v1, after, pyth: fields, lamports: 10, rentExemptLamports: 10 }),
      ).toEqual([]);
    }
  });

  it("reports any changed old byte, a wrong tail, a wrong size and missing rent (property)", () => {
    const v1 = devnetV1();
    const good = grow(v1, expectedPythTail(pyth));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: CONFIG_V2_LEN - 1 }), (offset) => {
        const bad = Uint8Array.from(good);
        bad[offset] = ((bad[offset] ?? 0) + 1) % 256;
        const problems = verifyMigrated({
          before: v1,
          after: bad,
          pyth,
          lamports: 1,
          rentExemptLamports: 1,
        });
        const expected =
          offset < CONFIG_V1_LEN ? `old byte ${offset} changed` : `byte ${offset} is not`;
        return problems.length === 1 && problems[0]?.includes(expected) === true;
      }),
    );
    const problems = verifyMigrated({
      before: v1.slice(1),
      after: good.slice(0, CONFIG_V2_LEN - 1),
      pyth,
      lamports: 1,
      rentExemptLamports: 2,
    });
    expect(problems.join("\n")).toMatch(/snapshot is 1075/);
    expect(problems.join("\n")).toMatch(/1143 bytes after migration/);
    expect(problems.join("\n")).toMatch(/below rent-exempt/);
  });
});

describe("classifyConfigAccount", () => {
  it("rejects a foreign owner, a wrong discriminator and an unknown size", () => {
    const v1 = devnetV1();
    expect(() => classifyConfigAccount(v1, PublicKey.default, PROGRAM_ID)).toThrow(/owned by/);
    const bad = Uint8Array.from(v1);
    bad[0] = 0;
    expect(() => classifyConfigAccount(bad, PROGRAM_ID, PROGRAM_ID)).toThrow(/discriminator/);
    expect(() => classifyConfigAccount(new Uint8Array(4), PROGRAM_ID, PROGRAM_ID)).toThrow(
      /discriminator/,
    );
    const odd = new Uint8Array(CONFIG_V1_LEN + 1);
    odd.set(v1, 0);
    expect(() => classifyConfigAccount(odd, PROGRAM_ID, PROGRAM_ID)).toThrow(/neither v1/);
    expect(() => decodeConfigPrefix(new Uint8Array(10))).toThrow(/shorter than v1/);
  });
});

describe("expectedPythTail and rentTopUp", () => {
  it("lays the Pyth fields out as the program stores them", () => {
    const tail = expectedPythTail({
      lazerSigner: signer,
      feedIds: [1, 2, 3, 4, 5, 6, 7],
      maxAgeSecs: 30n,
    });
    expect(tail.length).toBe(PYTH_TAIL_LEN);
    expect(Buffer.from(tail.slice(0, 32)).equals(signer.toBuffer())).toBe(true);
    expect(Buffer.from(tail).readUInt32LE(32)).toBe(1);
    expect(Buffer.from(tail).readUInt32LE(56)).toBe(7);
    expect(Buffer.from(tail).readBigInt64LE(60)).toBe(30n);
    expect(expectedPythTail(null).every((byte) => byte === 0)).toBe(true);
    expect(() => expectedPythTail({ ...pyth, feedIds: [1] })).toThrow(/7 slots/);
  });

  it("tops up only the shortfall", () => {
    expect(rentTopUp(100, 40)).toBe(60);
    expect(rentTopUp(100, 100)).toBe(0);
    expect(rentTopUp(100, 150)).toBe(0);
  });
});
