import { PublicKey } from "@solana/web3.js";

/** Program id of the upgradeable BPF loader. */
export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Bytes before the ELF in a ProgramData account: tag (4) + slot (8) + option (1 + 32). */
export const PROGRAM_DATA_HEADER_LEN = 45;

/** The ProgramData address held by an upgradeable Program account (tag 2), or null. */
export function programDataAddress(programAccountData: Uint8Array): PublicKey | null {
  if (programAccountData.length < 36) {
    return null;
  }
  const view = new DataView(
    programAccountData.buffer,
    programAccountData.byteOffset,
    programAccountData.byteLength,
  );
  if (view.getUint32(0, true) !== 2) {
    return null;
  }
  return new PublicKey(programAccountData.slice(4, 36));
}

export type ProgramDataHeader = {
  readonly slot: bigint;
  /** Upgrade authority, or null for an immutable program. */
  readonly authority: PublicKey | null;
};

/** Parses the header of an upgradeable ProgramData account (tag 3), or null. */
export function programDataHeader(data: Uint8Array): ProgramDataHeader | null {
  if (data.length < PROGRAM_DATA_HEADER_LEN) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 3) {
    return null;
  }
  const hasAuthority = data[12];
  if (hasAuthority !== 0 && hasAuthority !== 1) {
    return null;
  }
  return {
    slot: view.getBigUint64(4, true),
    authority: hasAuthority === 1 ? new PublicKey(data.slice(13, 45)) : null,
  };
}

function trimmedLength(bytes: Uint8Array, from: number): number {
  let end = bytes.length;
  while (end > from && bytes[end - 1] === 0) {
    end -= 1;
  }
  return end - from;
}

/**
 * True when the ELF stored on chain equals `localElf`. ProgramData accounts are allocated at
 * `--max-len`, so the stored ELF is followed by zero padding: both sides are compared after
 * trimming trailing zeros, which also means an older, longer build never matches a shorter one.
 */
export function onChainElfMatches(programData: Uint8Array, localElf: Uint8Array): boolean {
  if (programData.length < PROGRAM_DATA_HEADER_LEN) {
    return false;
  }
  const onChainLength = trimmedLength(programData, PROGRAM_DATA_HEADER_LEN);
  const localLength = trimmedLength(localElf, 0);
  if (onChainLength !== localLength) {
    return false;
  }
  for (let i = 0; i < localLength; i += 1) {
    if (programData[PROGRAM_DATA_HEADER_LEN + i] !== localElf[i]) {
      return false;
    }
  }
  return true;
}
