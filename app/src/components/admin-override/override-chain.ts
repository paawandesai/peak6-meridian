/**
 * The approve transaction (M3-06): `admin_settle_override` built for the admin's OWN wallet, one
 * transaction, one signature. Nothing is signed server-side and no key is read here. The price is
 * the draft's integer cents, unchanged. The program re-checks the admin signer and the delay
 * (AB-06, AB-07).
 */
import { AnchorProvider, BN, type Wallet } from "@coral-xyz/anchor";
import { createMeridianProgram, findConfigPda } from "@meridian/client";
import { type Connection, PublicKey } from "@solana/web3.js";

import type { SigningWallet } from "@/lib/admin-chain";
import type { PublicConfig } from "@/lib/config";

export type OverrideResult = { readonly signature: string; readonly slot: number };

export type OverrideActions = {
  /** Settles `market` (base58) at `priceCents` through one wallet signature. */
  approve(market: string, priceCents: bigint): Promise<OverrideResult>;
};

export function createOverrideActions(
  connection: Connection,
  wallet: SigningWallet,
  config: PublicConfig,
): OverrideActions {
  const provider = new AnchorProvider(connection, wallet as Wallet, { commitment: "confirmed" });
  const program = createMeridianProgram(provider, config.programId);
  return {
    async approve(market, priceCents) {
      if (priceCents < 1n) throw new Error("the settle price must be at least 1 cent");
      const signature = await program.methods
        .adminSettleOverride(new BN(priceCents.toString()))
        .accountsStrict({
          config: findConfigPda(config.programId).address,
          market: new PublicKey(market),
          admin: wallet.publicKey,
        })
        .rpc({ commitment: "confirmed" });
      const { value } = await connection.getSignatureStatuses([signature]);
      return { signature, slot: value[0]?.slot ?? 0 };
    },
  };
}
