import {
  type Connection,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { connectionExecutor } from "./executor";
import type { PlannedTx } from "./settleTx";

function fakeConnection(options: { error?: object | null; txSlot?: number | null } = {}) {
  const sent: Uint8Array[] = [];
  const connection = {
    getSlot: () => Promise.resolve(42),
    getLatestBlockhash: () =>
      Promise.resolve({
        blockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W",
        lastValidBlockHeight: 99,
      }),
    sendRawTransaction: (raw: Uint8Array) => {
      sent.push(raw);
      return Promise.resolve("sig-1");
    },
    getSignatureStatus: () =>
      Promise.resolve({
        value: options.txSlot === null ? null : { slot: options.txSlot ?? 75 },
      }),
    confirmTransaction: () =>
      Promise.resolve({ context: { slot: 77 }, value: { err: options.error ?? null } }),
  } as unknown as Connection;
  return { connection, sent };
}

function planned(payer: Keypair, versioned: boolean): PlannedTx {
  return {
    role: "settle",
    versioned,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
    luts: [],
    size: 0,
    settles: 1,
  };
}

describe("connectionExecutor", () => {
  it("reports the current slot", async () => {
    expect(
      await connectionExecutor(fakeConnection().connection, Keypair.generate()).currentSlot(),
    ).toBe(42);
  });

  it("signs a legacy transaction with the payer and returns the confirmation slot", async () => {
    const payer = Keypair.generate();
    const { connection, sent } = fakeConnection();
    const result = await connectionExecutor(connection, payer).send(planned(payer, false), []);
    // The slot the transaction was processed in (75), not the confirmation's context slot (77).
    expect(result).toEqual({ signature: "sig-1", slot: 75 });
    const tx = Transaction.from(sent[0] ?? new Uint8Array());
    expect(tx.feePayer?.equals(payer.publicKey)).toBe(true);
    expect(tx.verifySignatures()).toBe(true);
  });

  it("signs a versioned transaction with the payer and the extra signer once each", async () => {
    const payer = Keypair.generate();
    const admin = Keypair.generate();
    const { connection, sent } = fakeConnection();
    const executor = connectionExecutor(connection, payer);
    const tx: PlannedTx = {
      ...planned(payer, true),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
    };
    // The payer is passed again as an "extra" signer: it must not be applied twice.
    await executor.send(tx, [admin, payer]);
    const decoded = VersionedTransaction.deserialize(sent[0] ?? new Uint8Array());
    expect(decoded.message.header.numRequiredSignatures).toBe(2);
    expect(decoded.signatures).toHaveLength(2);
    expect(decoded.signatures.every((s) => s.some((byte) => byte !== 0))).toBe(true);
  });

  it("falls back to the confirmation slot when the status is not available", async () => {
    const payer = Keypair.generate();
    const { connection } = fakeConnection({ txSlot: null });
    expect(await connectionExecutor(connection, payer).send(planned(payer, false), [])).toEqual({
      signature: "sig-1",
      slot: 77,
    });
  });

  it("throws when the confirmation carries an error", async () => {
    const payer = Keypair.generate();
    const { connection } = fakeConnection({ error: { InstructionError: [0, "Custom"] } });
    await expect(
      connectionExecutor(connection, payer).send(planned(payer, false), []),
    ).rejects.toThrow(/failed/);
  });
});
