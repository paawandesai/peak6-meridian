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
