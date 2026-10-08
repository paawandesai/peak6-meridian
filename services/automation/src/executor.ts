/**
 * The real transaction sender: builds each planned transaction with a fresh blockhash, signs it
 * with the payer (and any adapter signers), sends and confirms it. This and `settleTx.ts` /
 * `switchboard.ts` / `cli/createMarkets.ts` are the only files that sign or send (AB-19 guard).
 */
import {
  type Connection,
  type Keypair,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import type { PlannedTx, TxExecutor } from "./settleTx";

export function connectionExecutor(connection: Connection, payer: Keypair): TxExecutor {
  return {
    currentSlot: () => connection.getSlot("confirmed"),
    async send(planned: PlannedTx, extraSigners: readonly Keypair[]) {
      const signers = [payer, ...extraSigners].filter(
        (signer, index, all) =>
          all.findIndex((other) => other.publicKey.equals(signer.publicKey)) === index,
      );
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      let raw: Uint8Array;
      if (planned.versioned) {
        const message = new TransactionMessage({
          payerKey: payer.publicKey,
          recentBlockhash: blockhash,
          instructions: [...planned.instructions],
        }).compileToV0Message([...planned.luts]);
        const tx = new VersionedTransaction(message);
        tx.sign(signers);
        raw = tx.serialize();
      } else {
        const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
        tx.add(...planned.instructions);
        tx.sign(...signers);
        raw = tx.serialize();
      }
      const signature = await connection.sendRawTransaction(raw, { maxRetries: 3 });
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (confirmation.value.err !== null) {
        throw new Error(
          `transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`,
        );
      }
      // The slot the transaction was processed in (what the oracle's staleness is measured
      // against), not the RPC's context slot, which can be a few slots later.
      const status = await connection.getSignatureStatus(signature);
      return { signature, slot: status.value?.slot ?? confirmation.context.slot };
    },
  };
}
