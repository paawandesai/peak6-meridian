import { PublicKey } from "@solana/web3.js";

/** Switchboard On-Demand program IDs; the program accepts feeds owned by either (oracle.rs). */
export const SWITCHBOARD_PROGRAM_IDS: readonly PublicKey[] = [
  new PublicKey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv"),
  new PublicKey("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2"),
];

/** True when `owner` is one of the Switchboard On-Demand programs. */
export function isSwitchboardOwner(owner: PublicKey): boolean {
  return SWITCHBOARD_PROGRAM_IDS.some((id) => id.equals(owner));
}

/** Offset of `feed_hash` in a `PullFeedAccountData` account (8-byte discriminator + 2,112). */
export const FEED_HASH_OFFSET = 8 + 2_112;

/** The feed hash stored in a Switchboard feed account's own data, or null if too short. */
export function feedAccountHash(data: Uint8Array): Uint8Array | null {
  return data.length < FEED_HASH_OFFSET + 32
    ? null
    : data.slice(FEED_HASH_OFFSET, FEED_HASH_OFFSET + 32);
}
