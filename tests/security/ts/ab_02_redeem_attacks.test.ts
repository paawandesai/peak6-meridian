// AB-02 · Redeem attacks (threat-model.md; NFR-07; M2-04 AC4).
// Attacks: (1) redeem the losing token, (2) redeem twice, (3) winner-redeem before settlement, (4)
// pair-redeem with YES/NO from different markets. Expected: loser pays 0; tokens are burned before
// transfer; winner mode requires `Settled`; pair redeem checks both tokens are from the same market.
//
// NOTE: Full redeem attack tests require transaction builders (redeemWinnerTx, redeemPairTx) that
// don't exist in the client yet. This file verifies settlement constraints (can't settle twice).
import type { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  createMarket,
  localFeedPda,
  setLocalFeed,
  SKIP_REASON,
  trySettle,
  validatorSession,
  waitUntil,
} from "./validator";

const v = validatorSession();
describe.runIf(v !== null)("AB-02 on-chain (local validator): settlement constraints", () => {
  it("settlement succeeds after close with valid feeds", { timeout: 180_000 }, async () => {
    if (v === null) {
      throw new Error(SKIP_REASON);
    }
    const { market, closeTs } = await createMarket(v, 10);
    await waitUntil(v, closeTs);

    const slot = await v.connection.getSlot("confirmed");
    await setLocalFeed(v, "META", 0, 50_000n, slot);
    await setLocalFeed(v, "META", 1, 50_000n, slot);

    const feeds: readonly [PublicKey, PublicKey] = [
      localFeedPda(v.programId, "META", 0),
      localFeedPda(v.programId, "META", 1),
    ] as const;

    const result = await trySettle(v, market, feeds);
    expect(result).toBe("settled");
  });

  it("cannot settle twice (double-settlement rejected)", { timeout: 180_000 }, async () => {
    if (v === null) {
      throw new Error(SKIP_REASON);
    }
    const { market, closeTs } = await createMarket(v, 10);
    await waitUntil(v, closeTs);

    const slot = await v.connection.getSlot("confirmed");
    await setLocalFeed(v, "META", 0, 50_000n, slot);
    await setLocalFeed(v, "META", 1, 50_000n, slot);

    const feeds: readonly [PublicKey, PublicKey] = [
      localFeedPda(v.programId, "META", 0),
      localFeedPda(v.programId, "META", 1),
    ] as const;

    // First settlement succeeds
    expect(await trySettle(v, market, feeds)).toBe("settled");

    // Second settlement should fail (AB-08: re-settle rejected)
    const result = await trySettle(v, market, feeds);
    expect(result).not.toBe("settled");
    expect(result.length).toBeGreaterThan(0); // Returns an error code
  });
});

describe.skipIf(v !== null)("AB-02 on-chain (local validator)", () => {
  it.skip(SKIP_REASON, () => undefined);
});
