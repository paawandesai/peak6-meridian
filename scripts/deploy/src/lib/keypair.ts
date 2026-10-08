import { readFileSync } from "node:fs";

import { Keypair } from "@solana/web3.js";
import { z } from "zod";

const secretKeySchema = z.array(z.number().int().min(0).max(255)).length(64);

/**
 * Reads a Solana keypair file (a JSON array of 64 bytes). Errors name the path and the problem,
 * never the contents: a malformed file may still hold secret bytes.
 */
export function readKeypairFile(path: string): Keypair {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
    throw new Error(`cannot read keypair file ${path} (${code})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`keypair file ${path} is not JSON`);
  }
  const parsed = secretKeySchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`keypair file ${path} is not a JSON array of 64 bytes`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed.data));
  } catch {
    throw new Error(`keypair file ${path} does not hold a valid ed25519 keypair`);
  }
}
