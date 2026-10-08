import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";

import {
  assertPublicOnly,
  type DeploymentRecord,
  readRecord,
  recordText,
  writeRecord,
} from "./record";

const dir = mkdtempSync(join(tmpdir(), "record-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const key = () => Keypair.generate().publicKey.toBase58();

const minimal = (): DeploymentRecord => ({ version: 1, cluster: "devnet", programId: key() });

describe("deployment record", () => {
  it("round-trips through the file and writes only when the text changes", () => {
    const path = join(dir, "nested", "a.json");
    const record: DeploymentRecord = {
      ...minimal(),
      usdcMint: key(),
      feeds: {
        AAPL: [
          { pubkey: key(), hash: "ab".repeat(32), placeholder: false },
          { pubkey: key(), hash: "00".repeat(32), placeholder: true },
        ],
      },
    };
    expect(writeRecord(path, record)).toBe(true);
    expect(writeRecord(path, record)).toBe(false);
    expect(readRecord(path)).toEqual(record);
    expect(readFileSync(path, "utf8")).toBe(recordText(record));
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  it("treats a missing or stale file as no record", () => {
    expect(readRecord(join(dir, "missing.json"))).toBeNull();
    const stale = join(dir, "stale.json");
    writeFileSync(stale, JSON.stringify({ version: 2 }));
    expect(readRecord(stale)).toBeNull();
    writeFileSync(stale, "not json");
    expect(readRecord(stale)).toBeNull();
  });

  it("refuses to write anything that could be key material", () => {
    const withBytes = {
      ...minimal(),
      feeds: { AAPL: [] },
    } as unknown as DeploymentRecord;
    expect(() => recordText(withBytes)).toThrow();
    expect(() => assertPublicOnly({ secretKey: "x" })).toThrow(/secret-like name/);
    expect(() => assertPublicOnly({ list: Array.from({ length: 64 }, () => 1) })).toThrow(
      /raw key bytes/,
    );
    expect(() => assertPublicOnly({ ok: [1, 2, 3], name: "x" })).not.toThrow();
  });

  it("rejects extra fields and non-pubkeys in the schema", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ ...minimal(), extra: 1 }));
    expect(readRecord(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ ...minimal(), programId: "nope" }));
    expect(readRecord(path)).toBeNull();
  });
});
