/** Signs and sends the Portfolio's transactions through the connected wallet (M2-07). */
import { AnchorProvider } from "@coral-xyz/anchor";
import { createMeridianProgram } from "@meridian/client";
import {
  type Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { buildRedeem, buildWithdraw, chunk } from "./tx";
import type { PublicConfig } from "@/lib/config";
import type { MarketRow } from "@/lib/markets";

export type RedeemItem = {
  readonly market: MarketRow;
  readonly yesQty: bigint;
  readonly noQty: bigint;
};

export type TxResult = { readonly signature: string; readonly slot: number };

/** What the view calls; tests pass a fake. Each call asks the wallet for ONE approval. */
export type PortfolioActions = {
  redeem(items: readonly RedeemItem[]): Promise<TxResult>;
  withdraw(markets: readonly MarketRow[]): Promise<TxResult>;
};

/** The wallet-adapter methods this module needs. */
export type SigningWallet = {
  readonly publicKey: PublicKey;
  signAllTransactions(transactions: Transaction[]): Promise<Transaction[]>;
};

function buildOnlyWallet(publicKey: PublicKey) {
  const refuse = () =>
    Promise.reject(new Error("instructions are signed through the wallet adapter"));
  return { publicKey, signTransaction: refuse, signAllTransactions: refuse };
}

export function createActions(
  config: PublicConfig,
  connection: Connection,
  wallet: SigningWallet,
): PortfolioActions {
  const usdcMint = config.usdcMint;
  // Only used to build instructions; signing goes through `wallet.signAllTransactions` below.
  const provider = new AnchorProvider(connection, buildOnlyWallet(wallet.publicKey), {
    commitment: "confirmed",
  });
  const program = createMeridianProgram(provider, config.programId);

  /** All transactions are signed in ONE wallet approval, then sent and confirmed in order. */
  async function run(groups: readonly TransactionInstruction[][]): Promise<TxResult> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const transactions = groups.map((instructions) => {
      const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight });
      tx.add(...instructions);
      return tx;
    });
    const signed = await wallet.signAllTransactions(transactions);
    let last: TxResult = { signature: "", slot: 0 };
    for (const tx of signed) {
      const signature = await connection.sendRawTransaction(tx.serialize());
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (confirmation.value.err !== null) {
        throw new Error(
          `the transaction failed on chain: ${JSON.stringify(confirmation.value.err)}`,
        );
      }
      last = { signature, slot: confirmation.context.slot };
    }
    return last;
  }

  function requireMint(): PublicKey {
    if (usdcMint === undefined) throw new Error("NEXT_PUBLIC_USDC_MINT is not configured");
    return usdcMint;
  }

  return {
    async redeem(items) {
      const mint = requireMint();
      const built = await Promise.all(
        items.map((item) =>
          buildRedeem({
            program,
            user: wallet.publicKey,
            usdcMint: mint,
            market: item.market,
            yesQty: item.yesQty,
            noQty: item.noQty,
          }),
        ),
      );
      return run(chunk(built).map((group) => group.flat()));
    },
    async withdraw(markets) {
      const mint = requireMint();
      const built = await Promise.all(
        markets.map((market) =>
          buildWithdraw({ program, owner: wallet.publicKey, usdcMint: mint, market }),
        ),
      );
      return run(chunk(built).map((group) => group.flat()));
    },
  };
}
