/**
 * Pyth Lazer updates signed by a throwaway Ed25519 key, in the real wire encoding
 * (pyth-lazer-protocol v0.46.0), plus the recorded update Pyth itself signed. No network.
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import {
  PAYLOAD_FORMAT_MAGIC,
  parseSolanaMessage,
  SOLANA_FORMAT_MAGIC,
  type SignedPythUpdate,
} from "../pythLazer";

export interface PythTestSigner {
  readonly publicKey: PublicKey;
  readonly privateKey: KeyObject;
}

export function pythTestSigner(): PythTestSigner {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // The last 32 bytes of the SPKI DER are the raw key.
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: new PublicKey(raw), privateKey };
}

export interface PayloadFields {
  readonly feedId: number;
  readonly timestampUs: bigint;
  /** Mantissa with `exponent`; 0 encodes "absent". */
  readonly price: bigint;
  readonly exponent?: number;
  /** 0 encodes "absent"; omit to leave the property out. */
  readonly confidence?: bigint;
  readonly channel?: number;
}

/** A PayloadData with Price, Exponent and (unless omitted) Confidence, in that order. */
export function encodePythPayload(fields: PayloadFields): Uint8Array {
  const withConfidence = fields.confidence !== undefined;
  const out = Buffer.alloc(4 + 8 + 1 + 1 + 4 + 1 + 9 + 3 + (withConfidence ? 9 : 0));
  let at = out.writeUInt32LE(PAYLOAD_FORMAT_MAGIC, 0);
  at = out.writeBigUInt64LE(fields.timestampUs, at);
  at = out.writeUInt8(fields.channel ?? 2, at);
  at = out.writeUInt8(1, at);
  at = out.writeUInt32LE(fields.feedId, at);
  at = out.writeUInt8(withConfidence ? 3 : 2, at);
  at = out.writeUInt8(0, at);
  at = out.writeBigInt64LE(fields.price, at);
  at = out.writeUInt8(4, at);
  at = out.writeInt16LE(fields.exponent ?? -8, at);
  if (fields.confidence !== undefined) {
    at = out.writeUInt8(5, at);
    out.writeBigInt64LE(fields.confidence, at);
  }
  return Uint8Array.from(out);
}

/** The SolanaMessage bytes Pyth would serve: envelope + `payload` signed by `signer`. */
export function signPythMessage(signer: PythTestSigner, payload: Uint8Array): Uint8Array {
  const signature = sign(null, payload, signer.privateKey);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(SOLANA_FORMAT_MAGIC, 0);
  const length = Buffer.alloc(2);
  length.writeUInt16LE(payload.length, 0);
  return Uint8Array.from(
    Buffer.concat([header, signature, signer.publicKey.toBuffer(), length, payload]),
  );
}

/** A decoded, validly signed update. */
export function signedPythUpdate(signer: PythTestSigner, fields: PayloadFields): SignedPythUpdate {
  return parseSolanaMessage(signPythMessage(signer, encodePythPayload(fields)));
}

const recordedSchema = z.object({
  source: z.string(),
  requestedTimestampUs: z.string(),
  feedId: z.number().int(),
  ticker: z.string(),
  closeTs: z.number().int(),
  solanaHex: z.string().regex(/^[0-9a-f]+$/),
});

export type RecordedPythUpdate = z.infer<typeof recordedSchema>;

/** A real update recorded from Pyth (`tests/fixtures`), as stored. */
export function loadRecordedPythUpdate(path: string): RecordedPythUpdate {
  return recordedSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
