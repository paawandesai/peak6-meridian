// @vitest-environment node
import { describe, expect, it } from "vitest";

import { FEE_SOL_UNAVAILABLE_MESSAGE } from "@/lib/faucet/response";

import { feeSolNotice } from "./funding";

const reply = (fee_sol_status: string, extra: Record<string, string> = {}) => ({
  signature: "sig",
  amount_base_units: "1000000000",
  fee_sol_status,
  fee_sol_lamports: fee_sol_status === "sent" ? "10000000" : "0",
  ...extra,
});

describe("feeSolNotice", () => {
  it("is silent when the demo wallet got fee SOL or already had some", () => {
    expect(feeSolNotice(reply("sent"))).toBeNull();
    expect(feeSolNotice(reply("not_needed"))).toBeNull();
  });

  it("says plainly that no fee SOL arrived when the faucet was low", () => {
    expect(feeSolNotice(reply("faucet_low", { fee_sol_message: "Low on SOL." }))).toBe(
      "Demo wallet: test-USDC arrived. Low on SOL.",
    );
    expect(feeSolNotice(reply("faucet_low"))).toBe(
      `Demo wallet: test-USDC arrived. ${FEE_SOL_UNAVAILABLE_MESSAGE}`,
    );
  });

  it("reports an unreadable reply instead of assuming the wallet can pay fees", () => {
    for (const body of [null, {}, "ok", { signature: "s", amount_base_units: "1" }]) {
      expect(feeSolNotice(body)).toContain("unclear whether SOL for network fees arrived");
    }
  });
});
