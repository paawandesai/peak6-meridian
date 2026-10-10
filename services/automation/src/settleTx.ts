/**
 * Settlement transactions (M2-04): per ticker, the oracle-update instructions first, then one
 * `settle_market` per open market, packed to fit the 1,232-byte packet limit.
 *
 * Fit, in order: (1) one legacy transaction; (2) one versioned transaction using the update's
 * address lookup tables; (3) a split: a feed-update transaction followed by `settle_market`
 * transactions, sent back to back. `settle_market` rejects a value older than
 * `max_staleness_slots` (30, about 12 s) with `OracleStale`, so the split path tracks the slots
 * since the update confirmed and re-sends the update instead of ever sending a settle that
 * would be stale.
 */
import { type Program } from "@coral-xyz/anchor";
import { type Meridian } from "@meridian/client";
import {
  type AddressLookupTableAccount,
  type Keypair,
  type PublicKey,
  Transaction,
  TransactionMessage,
  type TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

/** The packet size limit of a Solana transaction. */
export const MAX_TX_BYTES = 1_232;
const DUMMY_BLOCKHASH = "11111111111111111111111111111111";

export type TxRole = "update+settle" | "update" | "settle";

/** Instructions that go into one transaction, with the lookup tables it may use. */
export interface PlannedTx {
  readonly role: TxRole;
  readonly versioned: boolean;
  readonly instructions: readonly TransactionInstruction[];
  readonly luts: readonly AddressLookupTableAccount[];
  /** Serialized size with empty signatures, bytes. */
  readonly size: number;
  /** `settle_market` instructions in it (for reporting). */
  readonly settles: number;
}

export interface SettlementPlan {
  readonly shape: "single" | "single-v0" | "split";
  readonly txs: readonly PlannedTx[];
}

/** Size of `instructions` as a legacy or versioned transaction paid by `payer`. */
export function serializedSize(
  payer: PublicKey,
  instructions: readonly TransactionInstruction[],
  luts: readonly AddressLookupTableAccount[],
  versioned: boolean,
): number {
  if (!versioned) {
    const tx = new Transaction({ feePayer: payer, recentBlockhash: DUMMY_BLOCKHASH });
    tx.add(...instructions);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  }
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: DUMMY_BLOCKHASH,
    instructions: [...instructions],
  }).compileToV0Message([...luts]);
  return new VersionedTransaction(message).serialize().length;
}

function tryFit(
  payer: PublicKey,
  role: TxRole,
  versioned: boolean,
  instructions: readonly TransactionInstruction[],
  luts: readonly AddressLookupTableAccount[],
  settles: number,
): PlannedTx | null {
  try {
    const size = serializedSize(payer, instructions, luts, versioned);
    return size <= MAX_TX_BYTES ? { role, versioned, instructions, luts, size, settles } : null;
  } catch {
    // Legacy serialization throws once the message cannot be encoded at all.
    return null;
  }
}

/** The oracle update alone as one transaction (legacy if it fits, else versioned). */
export function planUpdateTx(
  payer: PublicKey,
  updateIxs: readonly TransactionInstruction[],
  luts: readonly AddressLookupTableAccount[],
): PlannedTx {
  const fit =
    tryFit(payer, "update", false, updateIxs, [], 0) ??
    tryFit(payer, "update", true, updateIxs, luts, 0);
  if (fit === null) {
    throw new Error("the oracle update alone does not fit in a transaction");
  }
  return fit;
}

/**
 * Packs `update` followed by `settles` into the fewest transactions that fit, per the order in
 * the module comment. Throws when even a single instruction cannot fit.
 */
export function planSettlement(params: {
  readonly payer: PublicKey;
  readonly updateIxs: readonly TransactionInstruction[];
  readonly luts: readonly AddressLookupTableAccount[];
  readonly settleIxs: readonly TransactionInstruction[];
}): SettlementPlan {
  const { payer, updateIxs, luts, settleIxs } = params;
  const all = [...updateIxs, ...settleIxs];

  const legacy = tryFit(payer, "update+settle", false, all, [], settleIxs.length);
  if (legacy !== null) {
    return { shape: "single", txs: [legacy] };
  }
  const v0 = tryFit(payer, "update+settle", true, all, luts, settleIxs.length);
  if (v0 !== null) {
    return { shape: "single-v0", txs: [v0] };
  }

  const update = planUpdateTx(payer, updateIxs, luts);
  const txs: PlannedTx[] = [update];
  let batch: TransactionInstruction[] = [];
  const flush = (): void => {
    if (batch.length === 0) {
      return;
    }
    const fit =
      tryFit(payer, "settle", false, batch, [], batch.length) ??
      tryFit(payer, "settle", true, batch, luts, batch.length);
    if (fit === null) {
      throw new Error("a settle_market batch does not fit in a transaction");
    }
    txs.push(fit);
    batch = [];
  };
  for (const ix of settleIxs) {
    const candidate = [...batch, ix];
    const fits =
      tryFit(payer, "settle", false, candidate, [], candidate.length) !== null ||
      tryFit(payer, "settle", true, candidate, luts, candidate.length) !== null;
    if (!fits) {
      flush();
    }
    batch.push(ix);
  }
  flush();
  return { shape: "split", txs };
}

/** `settle_market` for each market, with the Config-pinned feeds (and nothing else) as oracles. */
export async function buildSettleInstructions(params: {
  readonly program: Program<Meridian>;
  readonly config: PublicKey;
  readonly payer: PublicKey;
  readonly markets: readonly PublicKey[];
  /** The Config-pinned feeds of the ticker: Tiingo first, Twelve Data second. */
  readonly feeds: readonly [PublicKey, PublicKey];
}): Promise<TransactionInstruction[]> {
  const out: TransactionInstruction[] = [];
  for (const market of params.markets) {
    out.push(
      await params.program.methods
        .settleMarket(null) // ed25519_ix_index: null for Switchboard path (M3-10b adds Pyth)
        .accountsStrict({
          config: params.config,
          market,
          feedTiingo: params.feeds[0],
          feedTwelveData: params.feeds[1],
          redstonePrice: null, // Switchboard path (M3-10b: Pyth primary, RedStone fallback)
          oracleConfig: null, // Switchboard path
          instructionsSysvar: null, // Pyth path only (M3-10b)
          payer: params.payer,
        })
        .instruction(),
    );
  }
  return out;
}

// ---- sending ---------------------------------------------------------------------------------

/** Sends planned transactions; the real one signs with the payer and the adapter's signers. */
export interface TxExecutor {
  currentSlot(): Promise<number>;
  /** Signs, sends and confirms; resolves to the signature and the slot it confirmed in. */
  send(
    tx: PlannedTx,
    extraSigners: readonly Keypair[],
  ): Promise<{ signature: string; slot: number }>;
}

/** A freshly built oracle update: new values at the current slot, and who signs it. */
export interface RefreshedUpdate {
  readonly tx: PlannedTx;
  readonly signers: readonly Keypair[];
}

export interface SendReport {
  readonly signatures: readonly string[];
  /** Times the feed update had to be sent again because the slot budget ran out. */
  readonly reUpdates: number;
}

/**
 * Sends `plan`. For a split plan every settle transaction is preceded by a slot check against
 * `budgetSlots`: when more slots have passed since the last update landed, `refreshUpdate`
 * builds a NEW update (the oracle is asked again, the local oracle is written at the current
 * slot) and that is sent first. Re-sending the old payload would carry the old slot or an old
 * signed response and leave the value as stale as before. So a settle is never sent into a
 * stale value.
 */
export async function sendPlan(params: {
  readonly plan: SettlementPlan;
  readonly executor: TxExecutor;
  readonly signers: readonly Keypair[];
  readonly budgetSlots: number;
  /** Builds a fresh update transaction (new oracle answer at the current slot). */
  readonly refreshUpdate: () => Promise<RefreshedUpdate>;
  /** Safety bound on re-updates in one plan. */
  readonly maxReUpdates?: number;
}): Promise<SendReport> {
  const { plan, executor, signers, budgetSlots } = params;
  const signatures: string[] = [];
  if (plan.shape !== "split") {
    const only = plan.txs[0];
    if (only === undefined) {
      return { signatures, reUpdates: 0 };
    }
    signatures.push((await executor.send(only, signers)).signature);
    return { signatures, reUpdates: 0 };
  }
  const [update, ...settles] = plan.txs;
  if (update === undefined) {
    return { signatures, reUpdates: 0 };
  }
  const first = await executor.send(update, signers);
  signatures.push(first.signature);
  let updatedAt = first.slot;
  let reUpdates = 0;
  const maxReUpdates = params.maxReUpdates ?? 10;
  for (const settle of settles) {
    if ((await executor.currentSlot()) - updatedAt > budgetSlots) {
      if (reUpdates >= maxReUpdates) {
        throw new Error("the oracle update keeps going stale before the settle transactions land");
      }
      const fresh = await params.refreshUpdate();
      const again = await executor.send(fresh.tx, fresh.signers);
      signatures.push(again.signature);
      updatedAt = again.slot;
      reUpdates += 1;
    }
    signatures.push((await executor.send(settle, signers)).signature);
  }
  return { signatures, reUpdates };
}
