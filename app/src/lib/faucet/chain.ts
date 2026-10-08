/** The slice of the cluster the faucet needs, so the claim logic is testable without an RPC. */
import { getMint } from "@solana/spl-token";
import { type Connection, PublicKey, type Transaction } from "@solana/web3.js";

export type BlockhashInfo = { readonly blockhash: string; readonly lastValidBlockHeight: number };

/** `err` is the cluster's transaction error (`null` when there is none). */
export type SimulationResult = { readonly err: unknown };
export type ConfirmResult = { readonly err: unknown; readonly expired: boolean };

export type FaucetChain = {
  getGenesisHash(): Promise<string>;
  getBalance(address: PublicKey): Promise<number>;
  /** Mint authority of `mint`, or `null` when the authority is unset. */
  getMintAuthority(mint: PublicKey): Promise<PublicKey | null>;
  getMinimumBalanceForRentExemption(space: number): Promise<number>;
  /** Unix seconds of the cluster's latest confirmed block (never a local wall clock). */
  clusterUnixTime(): Promise<number>;
  getLatestBlockhash(): Promise<BlockhashInfo>;
  simulate(tx: Transaction): Promise<SimulationResult>;
  /** Sends the signed transaction once, without a preflight (the claim simulates first). */
  send(tx: Transaction): Promise<string>;
  /** Waits until confirmed, failed, or the blockhash expired (`lastValidBlockHeight` passed). */
  confirm(signature: string, info: BlockhashInfo): Promise<ConfirmResult>;
};

/** How many earlier slots to try when the latest confirmed slot has no block time yet. */
const BLOCK_TIME_SLOT_LOOKBACK = 20;

export function connectionChain(connection: Connection): FaucetChain {
  return {
    getGenesisHash: () => connection.getGenesisHash(),
    getBalance: (address) => connection.getBalance(address, "confirmed"),
    async getMintAuthority(mint) {
      const info = await getMint(connection, mint, "confirmed");
      return info.mintAuthority;
    },
    getMinimumBalanceForRentExemption: (space) =>
      connection.getMinimumBalanceForRentExemption(space),
    async clusterUnixTime() {
      const slot = await connection.getSlot("confirmed");
      for (let back = 0; back < BLOCK_TIME_SLOT_LOOKBACK && slot - back >= 0; back += 1) {
        const time = await connection.getBlockTime(slot - back);
        if (time !== null) return time;
      }
      throw new Error("the cluster reported no block time");
    },
    getLatestBlockhash: () => connection.getLatestBlockhash("confirmed"),
    async simulate(tx) {
      const result = await connection.simulateTransaction(tx);
      return { err: result.value.err };
    },
    send: (tx) =>
      connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 }),
    async confirm(signature, info) {
      try {
        const result = await connection.confirmTransaction(
          { signature, blockhash: info.blockhash, lastValidBlockHeight: info.lastValidBlockHeight },
          "confirmed",
        );
        return { err: result.value.err, expired: false };
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionExpiredBlockheightExceededError") {
          return { err: null, expired: true };
        }
        throw error;
      }
    },
  };
}
