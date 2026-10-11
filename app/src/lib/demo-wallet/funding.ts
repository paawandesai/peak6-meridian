/** Reads the faucet's success reply for the demo wallet's auto-fund (M4-07). */
import { faucetSuccessSchema, FEE_SOL_UNAVAILABLE_MESSAGE } from "@/lib/faucet/response";

/**
 * The message to show after a successful claim, or `null` when the demo wallet got what it needs
 * to trade (fee SOL sent, or it already had some). A reply that does not parse is reported too:
 * the wallet cannot tell whether it can pay network fees.
 */
export function feeSolNotice(body: unknown): string | null {
  const parsed = faucetSuccessSchema.safeParse(body);
  if (!parsed.success) {
    return "Demo wallet: test-USDC was requested, but the faucet's reply was unreadable, so it is unclear whether SOL for network fees arrived.";
  }
  if (parsed.data.fee_sol_status !== "faucet_low") return null;
  return `Demo wallet: test-USDC arrived. ${parsed.data.fee_sol_message ?? FEE_SOL_UNAVAILABLE_MESSAGE}`;
}
