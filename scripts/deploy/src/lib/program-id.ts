import { PublicKey } from "@solana/web3.js";

/** The program ID in `declare_id!("...")` of the program's `lib.rs`, or null when absent. */
export function declaredIdFromLibRs(source: string): string | null {
  const match = /declare_id!\(\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"\s*\)/.exec(source);
  return match?.[1] ?? null;
}

/** The `address` of an Anchor IDL JSON document, or null when absent. */
export function idlAddress(idlJson: string): string | null {
  const parsed: unknown = JSON.parse(idlJson);
  if (typeof parsed === "object" && parsed !== null && "address" in parsed) {
    return typeof parsed.address === "string" ? parsed.address : null;
  }
  return null;
}

export type ProgramIdSources = {
  /** Public key of `PROGRAM_KEYPAIR_PATH`. */
  readonly keypair: PublicKey;
  /** `declare_id!` in `programs/meridian/src/lib.rs`. */
  readonly declared: string | null;
  /** `address` in the IDL built by `make build-devnet`; null before the build. */
  readonly idl?: string | null;
  /** `MERIDIAN_PROGRAM_ID`, when set. */
  readonly env?: string | undefined;
};

/**
 * Asserts that every known source names the keypair's public key. A mismatched keypair would
 * deploy a program whose every instruction fails the declared-ID check, after the SOL is spent.
 */
export function assertProgramIds(sources: ProgramIdSources): void {
  const expected = sources.keypair.toBase58();
  const named: [string, string | null | undefined][] = [
    ["declare_id! in programs/meridian/src/lib.rs", sources.declared],
    ["IDL address (target/idl/meridian.json)", sources.idl],
    ["MERIDIAN_PROGRAM_ID", sources.env],
  ];
  const problems: string[] = [];
  for (const [name, value] of named) {
    if (value === undefined) {
      continue; // not set / not built yet
    }
    if (value === null) {
      problems.push(`${name} is missing`);
    } else if (value !== expected) {
      problems.push(`${name} is ${value}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `PROGRAM_KEYPAIR_PATH holds ${expected}, but ${problems.join("; ")}. ` +
        "Nothing was sent. Use the keypair for the declared ID, or re-key the program " +
        "(new declare_id! + `anchor keys sync` + rebuild) before deploying.",
    );
  }
}
