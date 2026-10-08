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

/**
 * The exact ProgramData comparison: skip the 45-byte header, require `len >= built_len`, require
 * `data[..built_len] == built`, and require every byte after `built_len` to be zero. Trailing
 * zeros of the on-chain data are never trimmed (that would break when the `.so` itself ends in
 * zero bytes); ProgramData is allocated at `--max-len`, so zero padding follows the ELF.
 */
export function onChainElfMatches(programData: Uint8Array, built: Uint8Array): boolean {
  const start = PROGRAM_DATA_HEADER_LEN;
  if (programData.length < start + built.length) {
    return false;
  }
  for (let i = 0; i < built.length; i += 1) {
    if (programData[start + i] !== built[i]) {
      return false;
    }
  }
  for (let i = start + built.length; i < programData.length; i += 1) {
    if (programData[i] !== 0) {
      return false;
    }
  }
  return true;
}

/** The on-chain bytes in the window of the built ELF's length (for printing a digest). */
export function onChainWindow(programData: Uint8Array, builtLength: number): Uint8Array {
  return programData.slice(PROGRAM_DATA_HEADER_LEN, PROGRAM_DATA_HEADER_LEN + builtLength);
}
