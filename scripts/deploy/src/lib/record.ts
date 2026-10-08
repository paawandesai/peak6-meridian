import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

const base58 = z.string().refine(
  (value) => {
    try {
      new PublicKey(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "not a base58 public key" },
);

const feedSchema = z.strictObject({
  pubkey: base58,
  /** 32-byte feed hash as 64 lower-case hex characters (zeros for a placeholder). */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** True while the slot still holds the default-pubkey placeholder. */
  placeholder: z.boolean(),
});

/**
 * The deployment record: public keys and public feed data only. Everything but the program ID
 * is optional so a write-ahead record (program ID + mint, written before the mint is created)
 * and the tracked "not deployed yet" file are valid records too.
 */
export const deploymentRecordSchema = z.strictObject({
  version: z.literal(1),
  cluster: z.enum(["devnet", "localnet"]),
  programId: base58,
  usdcMint: base58.optional(),
  configPda: base58.optional(),
  admin: base58.optional(),
  automationAuthority: base58.optional(),
  faucet: base58.optional(),
  upgradeAuthority: base58.optional(),
  feeds: z.record(z.string(), z.tuple([feedSchema, feedSchema])).optional(),
});

export type DeploymentRecord = z.infer<typeof deploymentRecordSchema>;

/** The record at `path`, or null when it is missing or does not parse (a stale record). */
export function readRecord(path: string): DeploymentRecord | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = deploymentRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Stable JSON text of a record (keys in schema order, two-space indent, trailing newline). */
export function recordText(record: DeploymentRecord): string {
  const checked = deploymentRecordSchema.parse(record);
  assertPublicOnly(checked);
  return `${JSON.stringify(checked, null, 2)}\n`;
}

/**
 * Writes the record only when its text changes, through a temporary file and a rename.
 * Returns true when the file was written.
 */
export function writeRecord(path: string, record: DeploymentRecord): boolean {
  const text = recordText(record);
  try {
    if (readFileSync(path, "utf8") === text) {
      return false;
    }
  } catch {
    // missing: write it
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
  return true;
}

/** Throws when a value could hold secret key material: a 64-byte array or a secret-like key. */
export function assertPublicOnly(value: unknown, path = "record"): void {
  if (Array.isArray(value)) {
    const bytes =
      value.length >= 32 && value.every((x) => Number.isInteger(x) && x >= 0 && x < 256);
    if (bytes) {
      throw new Error(`${path} looks like raw key bytes; the record holds public keys only`);
    }
    value.forEach((item, index) => assertPublicOnly(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (/secret|private|seed|mnemonic|keypair/i.test(key)) {
        throw new Error(`${path}.${key} has a secret-like name; the record holds public keys only`);
      }
      assertPublicOnly(item, `${path}.${key}`);
    }
  }
}
