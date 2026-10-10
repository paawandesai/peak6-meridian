/** The running stack's public facts, written by global-setup and read by specs (a temp JSON file). */
import { readFileSync } from "node:fs";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";

const secretKey = z.array(z.number().int().min(0).max(255)).length(64);

const stateSchema = z.object({
  rpcUrl: z.string().url(),
  appUrl: z.string().url(),
  programId: z.string().min(32),
  usdcMint: z.string().min(32),
  /** Throwaway local-validator keys only; the state file is mode 0600 in a temp dir. */
  adminKeypairPath: z.string().min(1),
  walletSecret: secretKey,
  tradingDate: z.number().int(),
});
export type StackState = z.infer<typeof stateSchema>;

export const STATE_ENV = "E2E_STACK_STATE";

export function loadState(): StackState {
  const path = process.env[STATE_ENV];
  if (path === undefined || path === "") {
    throw new Error(`${STATE_ENV} is not set: global-setup did not run`);
  }
  return stateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function keypairFrom(secret: readonly number[]): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function loadKeypairFile(path: string): Keypair {
  return keypairFrom(secretKey.parse(JSON.parse(readFileSync(path, "utf8"))));
}

export function connectionFor(state: StackState): Connection {
  return new Connection(state.rpcUrl, "confirmed");
}

export const programIdOf = (state: StackState): PublicKey => new PublicKey(state.programId);
