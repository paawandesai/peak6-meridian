/**
 * The faucet's success reply (POST /api/faucet), shared by the route, the "Get test-USDC" button
 * and the demo wallet. Client-safe: no keys, no environment, no RPC.
 */
import { z } from "zod";

/** SOL sent with a claim for network fees: 0.01 SOL, enough for hundreds of trades. */
export const FEE_SOL_LAMPORTS = 10_000_000n;
/** A claimant holding less than this (0.005 SOL) gets `FEE_SOL_LAMPORTS` with its test-USDC. */
export const FEE_SOL_THRESHOLD_LAMPORTS = 5_000_000n;

/** Shown when the claim minted test-USDC but the faucet could not spare the fee SOL. */
export const FEE_SOL_UNAVAILABLE_MESSAGE =
  "The faucet is low on SOL, so it sent no SOL for network fees. You need a little devnet SOL " +
  "to trade; try again later or get devnet SOL elsewhere.";

/**
 * `sent`: the claim transferred `fee_sol_lamports`; `not_needed`: the wallet already held at least
 * the threshold; `faucet_low`: the faucet's SOL would have dropped below its floor, so only
 * test-USDC was sent (`fee_sol_message` says so).
 */
export const feeSolStatusSchema = z.enum(["sent", "not_needed", "faucet_low"]);
export type FeeSolStatus = z.infer<typeof feeSolStatusSchema>;

export const faucetSuccessSchema = z.object({
  signature: z.string(),
  amount_base_units: z.string().regex(/^\d+$/),
  fee_sol_status: feeSolStatusSchema,
  fee_sol_lamports: z.string().regex(/^\d+$/),
  fee_sol_message: z.string().optional(),
});
export type FaucetSuccess = z.infer<typeof faucetSuccessSchema>;

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Lamports as SOL with no trailing zeros, by integer arithmetic: 10_000_000n → "0.01 SOL". */
export function formatLamportsAsSol(lamports: bigint): string {
  if (lamports < 0n) throw new RangeError("lamports must be non-negative");
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole.toString()}${fraction === "" ? "" : `.${fraction}`} SOL`;
}
