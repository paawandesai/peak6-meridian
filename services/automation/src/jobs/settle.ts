/**
 * Settlement job placeholder (M2-04 replaces this file). The schedule exists from M2-03 so the
 * service wiring, `/health` and the degraded mode (AC5: settlement keeps running when the
 * automation key does not match, because `settle_market` is permissionless) are already right.
 */
import type { Keypair } from "@solana/web3.js";

import type { JobSpec } from "../scheduler";

/** Every minute: M2-04 checks which markets are due at close + 5 min (early-close aware). */
export const SETTLEMENT_CRON = "* * * * *";

/** `signer` is the loaded automation key: the real job signs its transactions with it. */
export function placeholderSettlementJob(signer: Keypair): JobSpec {
  return {
    signer: signer.publicKey.toBase58(),
    placeholder: true,
    name: "settlement",
    cron: SETTLEMENT_CRON,
    run: () => Promise.resolve(),
  };
}
