/**
 * In-memory stand-in for the cluster, for the faucet's unit and abuse-case tests. It interprets
 * the transaction's real instructions (system transfer and allocate-with-seed, ATA creation,
 * token mint-to) against a small account model, atomically, so marker conflicts, partial
 * failures and concurrent claims behave like the cluster. The local-validator behaviour is covered
 * by `make e2e`. Test support only: nothing in the app imports this.
 */
import { DEVNET_GENESIS_HASH } from "@meridian/client";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemInstruction, SystemProgram, type Transaction } from "@solana/web3.js";

import type { BlockhashInfo, ConfirmResult, FaucetChain, SimulationResult } from "./chain";

type Account = { lamports: number; dataLen: number };
type Outcome = {
  err: unknown;
  mints: { ata: string; amount: bigint }[];
  accounts: Map<string, Account>;
  balance: number;
};

export class FakeFaucetChain implements FaucetChain {
  genesisHash = DEVNET_GENESIS_HASH;
  genesisError: Error | undefined;
  /** Cluster time in unix seconds; tests move it. */
  unixTime = 1_791_500_000;
  /**
   * Lamports of the faucet key (the mint authority). Transfers from it debit it, and one that
   * would take it below zero fails like the system program's insufficient-funds error. Every other
   * address's lamports live in `accounts` (0 when absent).
   */
  balance = 5_000_000_000;
  mintAuthority: PublicKey | null = null;
  rent = 890_880;
  accounts = new Map<string, Account>();
  mints: { ata: string; amount: bigint }[] = [];
  sentSignatures: string[] = [];
  /** Every transaction handed to `send`, landed or not. */
  sentTransactions: Transaction[] = [];
  simulations = 0;
  blockhashes = 0;
  /** Makes the ATA instruction fail with this system/other error code. */
  ataFailsWith: number | undefined;
  /** Makes the next sent transaction expire without landing. */
  expireNext = false;
  /** Runs between simulate and send, to interleave concurrent claims. */
  beforeSend: (() => Promise<void>) | undefined;
  private readonly results = new Map<string, ConfirmResult>();
  private signatureCounter = 0;

  /** A copy with the same account state (and no mints), to probe "what if" without consuming markers. */
  clone(): FakeFaucetChain {
    const copy = new FakeFaucetChain();
    copy.genesisHash = this.genesisHash;
    copy.unixTime = this.unixTime;
    copy.balance = this.balance;
    copy.mintAuthority = this.mintAuthority;
    copy.rent = this.rent;
    copy.accounts = new Map([...this.accounts].map(([k, v]) => [k, { ...v }]));
    return copy;
  }

  getGenesisHash(): Promise<string> {
    return this.genesisError === undefined
      ? Promise.resolve(this.genesisHash)
      : Promise.reject(this.genesisError);
  }
  getBalance(address: PublicKey): Promise<number> {
    if (this.mintAuthority !== null && address.equals(this.mintAuthority)) {
      return Promise.resolve(this.balance);
    }
    return Promise.resolve(this.accounts.get(address.toBase58())?.lamports ?? 0);
  }
  getMintAuthority(): Promise<PublicKey | null> {
    return Promise.resolve(this.mintAuthority);
  }
  getMinimumBalanceForRentExemption(): Promise<number> {
    return Promise.resolve(this.rent);
  }
  clusterUnixTime(): Promise<number> {
    return Promise.resolve(this.unixTime);
  }
  getLatestBlockhash(): Promise<BlockhashInfo> {
    this.blockhashes += 1;
    // A valid base58 32-byte value, as a real blockhash is.
    const blockhash = new PublicKey(new Uint8Array(32).fill(this.blockhashes)).toBase58();
    return Promise.resolve({ blockhash, lastValidBlockHeight: 1_000 + this.blockhashes });
  }

  private async evaluate(tx: Transaction, commit: boolean): Promise<Outcome> {
    // Every await happens before the state is read, so applying a transaction is atomic: two
    // concurrent claims cannot both start from the same snapshot (no lost update).
    const expectedMarkers = new Map<number, PublicKey>();
    for (const [index, ix] of tx.instructions.entries()) {
      if (
        ix.programId.equals(SystemProgram.programId) &&
        SystemInstruction.decodeInstructionType(ix) === "AllocateWithSeed"
      ) {
        const { basePubkey, seed, programId } = SystemInstruction.decodeAllocateWithSeed(ix);
        expectedMarkers.set(index, await PublicKey.createWithSeed(basePubkey, seed, programId));
      }
    }
    const accounts = new Map([...this.accounts].map(([k, v]) => [k, { ...v }]));
    const mints: Outcome["mints"] = [];
    let balance = this.balance;
    for (const [index, ix] of tx.instructions.entries()) {
      const fail = (code: number): Outcome => ({
        err: { InstructionError: [index, { Custom: code }] },
        mints: [],
        accounts: this.accounts,
        balance: this.balance,
      });
      if (ix.programId.equals(SystemProgram.programId)) {
        const type = SystemInstruction.decodeInstructionType(ix);
        if (type === "Transfer") {
          const { fromPubkey, toPubkey, lamports } = SystemInstruction.decodeTransfer(ix);
          if (this.mintAuthority !== null && fromPubkey.equals(this.mintAuthority)) {
            // SystemError::ResultWithNegativeLamports (custom error 1): not enough lamports.
            if (balance < Number(lamports)) return fail(1);
            balance -= Number(lamports);
          }
          const account = accounts.get(toPubkey.toBase58()) ?? { lamports: 0, dataLen: 0 };
          account.lamports += Number(lamports);
          accounts.set(toPubkey.toBase58(), account);
        } else if (type === "AllocateWithSeed") {
          const { accountPubkey, space } = SystemInstruction.decodeAllocateWithSeed(ix);
          if (!expectedMarkers.get(index)?.equals(accountPubkey)) return fail(99);
          const account = accounts.get(accountPubkey.toBase58()) ?? { lamports: 0, dataLen: 0 };
          // SystemError::AccountAlreadyInUse (custom error 0): the account already has data.
          if (account.dataLen > 0) return fail(0);
          account.dataLen = Number(space);
          accounts.set(accountPubkey.toBase58(), account);
        } else {
          return fail(98);
        }
      } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
        if (this.ataFailsWith !== undefined) return fail(this.ataFailsWith);
      } else if (ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 7) {
        const ata = ix.keys[1]?.pubkey.toBase58() ?? "";
        mints.push({ ata, amount: ix.data.readBigUInt64LE(1) });
      } else {
        return fail(97);
      }
    }
    if (commit) {
      // Applied in the same synchronous step as the check, so concurrent claims cannot both win.
      this.accounts = accounts;
      this.mints.push(...mints);
      this.balance = balance;
    }
    return { err: null, mints, accounts, balance };
  }

  async simulate(tx: Transaction): Promise<SimulationResult> {
    this.simulations += 1;
    return { err: (await this.evaluate(tx, false)).err };
  }

  async send(tx: Transaction): Promise<string> {
    if (this.beforeSend !== undefined) await this.beforeSend();
    // An expiring transaction never lands (the blockhash passes before any leader includes it).
    this.sentTransactions.push(tx);
    const dropped = this.expireNext;
    this.expireNext = false;
    const outcome = await this.evaluate(tx, !dropped);
    this.signatureCounter += 1;
    const signature = `sig-${this.signatureCounter}`;
    this.sentSignatures.push(signature);
    this.results.set(signature, { err: outcome.err, expired: dropped });
    return signature;
  }

  confirm(signature: string): Promise<ConfirmResult> {
    return Promise.resolve(this.results.get(signature) ?? { err: null, expired: true });
  }
}
