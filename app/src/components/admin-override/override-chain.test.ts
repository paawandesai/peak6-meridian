// @vitest-environment node
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { findConfigPda, MERIDIAN_IDL, MERIDIAN_PROGRAM_ID } from "@meridian/client";
import {
  Connection,
  Keypair,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";
import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { createOverrideActions } from "./override-chain";
import { MARKET_ADDRESS } from "./test-support";
import type { SigningWallet } from "@/lib/admin-chain";
import type { PublicConfig } from "@/lib/config";

const coder = new BorshInstructionCoder(MERIDIAN_IDL);
const config: PublicConfig = {
  cluster: "localnet",
  rpcUrl: "http://127.0.0.1:8899",
  programId: MERIDIAN_PROGRAM_ID,
};

/** A connection that records the one transaction sent; signing is a spy on the wallet. */
function harness() {
  const admin = Keypair.generate();
  const sent: Transaction[] = [];
  const connection = new Connection("http://127.0.0.1:1");
  Object.assign(connection, {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: vi.fn().mockResolvedValue("SigOverride"),
    confirmTransaction: vi.fn().mockResolvedValue({ context: { slot: 1 }, value: { err: null } }),
    getSignatureStatuses: vi
      .fn()
      .mockResolvedValue({ context: { slot: 1 }, value: [{ slot: 55 }] }),
    getSignatureStatus: vi.fn().mockResolvedValue({
      context: { slot: 1 },
      value: { slot: 55, confirmations: 1, err: null, confirmationStatus: "confirmed" },
    }),
  });
  const wallet = {
    publicKey: admin.publicKey,
    signTransaction: vi.fn(
      async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
        // What the wallet adapter does: sign with the admin key (a throwaway one made in memory).
        (tx as Transaction).partialSign(admin);
        sent.push(tx as Transaction);
        return tx;
      },
    ),
    signAllTransactions: vi.fn(
      async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => txs,
    ),
  };
  return {
    admin,
    sent,
    connection,
    wallet,
    actions: createOverrideActions(connection, wallet as unknown as SigningWallet, config),
  };
}

describe("approve (M3-06 AC3)", () => {
  it("asks the admin's wallet for ONE signature on ONE admin_settle_override with the price unchanged", async () => {
    const { actions, wallet, sent, admin } = harness();
    const result = await actions.approve(MARKET_ADDRESS, 18_142n);
    expect(result).toEqual({ signature: "SigOverride", slot: 55 });
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    const instructions = sent[0]?.instructions ?? [];
    expect(instructions).toHaveLength(1);
    const ix = instructions[0];
    const decoded = coder.decode(Buffer.from(ix?.data ?? [])) as {
      name: string;
      data: { settle_price_cents: { toString(): string } };
    } | null;
    expect(decoded?.name).toBe("admin_settle_override");
    expect(decoded?.data.settle_price_cents.toString()).toBe("18142");
    // Accounts: config, market, admin (the signer).
    expect(ix?.keys.map((k) => k.pubkey.toBase58())).toEqual([
      findConfigPda(MERIDIAN_PROGRAM_ID).address.toBase58(),
      MARKET_ADDRESS,
      admin.publicKey.toBase58(),
    ]);
    expect(ix?.keys[2]).toMatchObject({ isSigner: true });
    expect(sent[0]?.feePayer?.toBase58()).toBe(admin.publicKey.toBase58());
  });

  it("passes any integer cents price through unchanged (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 1n, max: 10n ** 12n }), async (cents) => {
        const { actions, sent } = harness();
        await actions.approve(MARKET_ADDRESS, cents);
        const data = sent[0]?.instructions[0]?.data ?? Buffer.alloc(0);
        const decoded = coder.decode(Buffer.from(data)) as unknown as {
          data: { settle_price_cents: { toString(): string } };
        };
        expect(decoded.data.settle_price_cents.toString()).toBe(cents.toString());
      }),
      { numRuns: 25 },
    );
  });

  it("refuses a zero price and a market that is not an address, before any signature", async () => {
    const { actions, wallet } = harness();
    await expect(actions.approve(MARKET_ADDRESS, 0n)).rejects.toThrow(/at least 1 cent/);
    await expect(actions.approve("not-an-address", 100n)).rejects.toThrow();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    void PublicKey;
  });

  it("surfaces a declined signature without sending anything", async () => {
    const { actions, wallet, connection } = harness();
    wallet.signTransaction.mockRejectedValueOnce(new Error("User rejected the request"));
    await expect(actions.approve(MARKET_ADDRESS, 100n)).rejects.toThrow(
      "User rejected the request",
    );
    expect(
      (connection as unknown as { sendRawTransaction: ReturnType<typeof vi.fn> })
        .sendRawTransaction,
    ).not.toHaveBeenCalled();
  });
});
