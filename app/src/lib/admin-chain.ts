/**
 * Admin transactions (M2-10). The admin's own wallet signs; nothing is signed server-side and no
 * key is read here. `AdminActions` is the seam the page and its tests use.
 */
import { AnchorProvider, BN, type Wallet } from "@coral-xyz/anchor";
import {
  createMeridianProgram,
  findConfigPda,
  marketAddresses,
  symbolBytes,
} from "@meridian/client";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { type Connection, type PublicKey, SystemProgram, type Transaction } from "@solana/web3.js";
import type { VersionedTransaction } from "@solana/web3.js";

import type { AddStrikeParams } from "./admin";
import type { PublicConfig } from "./config";

export type AdminResult = { readonly signature: string; readonly slot: number };

export type AdminActions = {
  addStrike(params: AddStrikeParams): Promise<AdminResult>;
  setPaused(paused: boolean): Promise<AdminResult>;
};

/** The slice of the wallet adapter the admin transactions need. */
export type SigningWallet = {
  readonly publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
};

export function createAdminActions(
  connection: Connection,
  wallet: SigningWallet,
  config: PublicConfig,
): AdminActions {
  const provider = new AnchorProvider(connection, wallet as Wallet, { commitment: "confirmed" });
  const program = createMeridianProgram(provider, config.programId);
  const configPda = findConfigPda(config.programId).address;

  async function slotOf(signature: string): Promise<AdminResult> {
    const { value } = await connection.getSignatureStatuses([signature]);
    return { signature, slot: value[0]?.slot ?? 0 };
  }

  return {
    async addStrike(params) {
      const addresses = marketAddresses(
        { symbol: params.ticker, tradingDate: params.tradingDate, strikeCents: params.strikeCents },
        config.programId,
      );
      const configAccount = await program.account.config.fetch(configPda);
      const signature = await program.methods
        .addStrike(
          Array.from(symbolBytes(params.ticker)),
          new BN(params.strikeCents.toString()),
          params.tradingDate,
          new BN(params.closeTs.toString()),
        )
        .accountsStrict({
          config: configPda,
          admin: wallet.publicKey,
          market: addresses.market,
          yesMint: addresses.yesMint,
          noMint: addresses.noMint,
          vault: addresses.vault,
          escrowUsdc: addresses.escrowUsdc,
          escrowYes: addresses.escrowYes,
          book: addresses.book,
          usdcMint: configAccount.usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
      return slotOf(signature);
    },
    async setPaused(paused) {
      const method = paused ? program.methods.pause() : program.methods.unpause();
      const signature = await method
        .accountsStrict({ config: configPda, admin: wallet.publicKey })
        .rpc({ commitment: "confirmed" });
      return slotOf(signature);
    },
  };
}

/** Explorer link for a signature on the configured cluster. */
export function explorerTxUrl(signature: string, config: PublicConfig): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (config.cluster === "devnet") return `${base}?cluster=devnet`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(config.rpcUrl)}`;
}
