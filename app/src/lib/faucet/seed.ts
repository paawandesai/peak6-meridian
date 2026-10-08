/**
 * Marker accounts that make the faucet limit atomic (M2-09): one tiny system-owned account per
 * wallet per UTC day bucket. A claim creates the markers for buckets N and N+1 in the same
 * transaction as the mint, so a second claim whose bucket is already marked fails inside
 * `allocateWithSeed` (the account already has data), on any instance, with no shared store.
 *
 * Seed encoding (pinned; changing it would split the marker namespace): the first 32 lowercase
 * hex characters of `sha256(wallet pubkey (32 raw bytes) || bucket (u64 little-endian))`.
 */
import { createHash } from "node:crypto";

import { u64Le } from "@meridian/client";
import { PublicKey, SystemProgram } from "@solana/web3.js";

/** Seconds in a UTC day bucket. */
export const SECONDS_PER_DAY = 86_400;

/** `floor(unix_ts / 86400)`. */
export function dayBucket(unixSeconds: number): bigint {
  if (!Number.isInteger(unixSeconds) || unixSeconds < 0) {
    throw new Error(`not a unix timestamp: ${unixSeconds}`);
  }
  return BigInt(Math.floor(unixSeconds / SECONDS_PER_DAY));
}

/** The 32-character seed of one wallet and day bucket. */
export function markerSeed(wallet: PublicKey, bucket: bigint): string {
  const digest = createHash("sha256").update(wallet.toBytes()).update(u64Le(bucket)).digest("hex");
  return digest.slice(0, 32);
}

/** The marker account address: `createWithSeed(base, seed, SystemProgram)`. */
export function markerAddress(
  base: PublicKey,
  wallet: PublicKey,
  bucket: bigint,
): Promise<PublicKey> {
  return PublicKey.createWithSeed(base, markerSeed(wallet, bucket), SystemProgram.programId);
}
