/**
 * The generated Anchor client. `src/idl/` is written by `make client` from the local build;
 * regenerate it whenever the program's interface changes.
 */
import { type Idl, Program, type Provider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import type { Meridian } from "./idl/meridian";
import idl from "./idl/meridian.json";

/** The program IDL as `anchor build` wrote it (snake_case names; `Program` camel-cases them). */
export const MERIDIAN_IDL: Idl = idl as Idl;

/** The program ID declared in the IDL (same ID serves localnet and devnet). */
export const MERIDIAN_PROGRAM_ID = new PublicKey(MERIDIAN_IDL.address);

/** Instruction names in the IDL (snake_case). */
export function idlInstructionNames(): readonly string[] {
  return MERIDIAN_IDL.instructions.map((instruction) => instruction.name);
}

/**
 * A typed `Program<Meridian>` bound to `provider`. Pass `programId` to target a deployment
 * other than the one in the IDL (for example the throwaway ID used by `make e2e`).
 */
export function createMeridianProgram(
  provider: Provider,
  programId: PublicKey = MERIDIAN_PROGRAM_ID,
): Program<Meridian> {
  // The IDL type pins `address` to the build's ID; the runtime IDL may point elsewhere.
  const idlForProgram = { ...MERIDIAN_IDL, address: programId.toBase58() } as Meridian;
  return new Program<Meridian>(idlForProgram, provider);
}
