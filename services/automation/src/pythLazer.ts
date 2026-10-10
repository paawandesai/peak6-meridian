/**
 * Pyth Lazer (Pyth Pro) signed closes for settlement (D-055): fetch the update Pyth signed at a
 * market's close, decode it, verify its Ed25519 signature off-chain and apply the same rules as
 * `settle_market` so a bad update is refused before any transaction is sent.
 *
 * Automation's own helper on purpose: the shared Pyth clients (`src/pyth`, the app, quant) read
 * prices for display and are not touched by the settlement path.
 *
 * Wire format (pyth-lazer-protocol v0.46.0, little-endian), mirrored by
 * `programs/meridian/src/pyth/mod.rs`:
 * - SolanaMessage: magic u32, signature [64], public key [32], payload length u16, payload.
 *   The signature covers the payload bytes only.
 * - PayloadData: magic u32, timestamp_us u64, channel u8, feed count u8, then per feed: id u32,
 *   property count u8, and per property its id u8 and value. Price (0) and Confidence (5) are a
 *   bare i64 mantissa (0 = absent); Exponent (4) is an i16.
 *
 * REST: `POST {base}/v1/price` (bearer token) returns the update issued at `timestamp` (µs);
 * 404 when there is none. The token is never logged nor put in an error.
 */
import { createPublicKey, verify } from "node:crypto";

import { z } from "zod";

export const PYTH_LAZER_URL = "https://pyth-lazer.dourolabs.app";
/** Updates every 200 ms, aligned on the second: a close at :00 has an update at exactly :00. */
export const PYTH_CHANNEL = "fixed_rate@200ms";
export const SOLANA_FORMAT_MAGIC = 2_182_742_457;
export const PAYLOAD_FORMAT_MAGIC = 2_479_346_549;
const PROPERTY = { price: 0, exponent: 4, confidence: 5 } as const;
const ENVELOPE_LEN = 102;
const BPS_DENOMINATOR = 10_000n;

/** Pyth Pro numeric feed ids of the MAG7 regular-session feeds (issue #49). */
export const PYTH_FEED_IDS: Readonly<Record<string, number>> = {
  AAPL: 922,
  AMZN: 954,
  GOOGL: 1163,
  META: 1272,
  MSFT: 1292,
  NVDA: 1314,
  TSLA: 1435,
};

export interface PythPayload {
  readonly timestampUs: bigint;
  readonly channel: number;
  readonly feedId: number;
  /** Mantissa; the value is `price × 10^exponent`. */
  readonly price: bigint;
  readonly exponent: number;
  /** Same exponent as `price`; null when Pyth sent none. */
  readonly confidence: bigint | null;
}

export interface SignedPythUpdate {
  readonly signature: Uint8Array;
  readonly publicKey: Uint8Array;
  /** The signed bytes: exactly what goes into the Ed25519 instruction. */
  readonly payload: Uint8Array;
  readonly parsed: PythPayload;
}

/** A forward-only, bounds-checked little-endian reader. */
class Reader {
  private pos = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private advance(n: number): number {
    if (this.pos + n > this.bytes.length) {
      throw new Error("pyth update is truncated");
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }
  u8 = (): number => this.view.getUint8(this.advance(1));
  u16 = (): number => this.view.getUint16(this.advance(2), true);
  i16 = (): number => this.view.getInt16(this.advance(2), true);
  u32 = (): number => this.view.getUint32(this.advance(4), true);
  u64 = (): bigint => this.view.getBigUint64(this.advance(8), true);
  i64 = (): bigint => this.view.getBigInt64(this.advance(8), true);
  bytesOf = (n: number): Uint8Array => this.bytes.slice(this.advance(n), this.pos);
  get done(): boolean {
    return this.pos === this.bytes.length;
  }
}

/**
 * Decodes a PayloadData with the program's rules: exactly one feed, only Price / Exponent /
 * Confidence, each at most once, no trailing bytes, a non-zero price.
 */
export function parsePythPayload(bytes: Uint8Array): PythPayload {
  const r = new Reader(bytes);
  if (r.u32() !== PAYLOAD_FORMAT_MAGIC) {
    throw new Error("pyth payload magic mismatch");
  }
  const timestampUs = r.u64();
  const channel = r.u8();
  if (r.u8() !== 1) {
    throw new Error("pyth payload must carry exactly one feed");
  }
  const feedId = r.u32();
  const count = r.u8();
  const seen = new Map<number, bigint | number>();
  for (let i = 0; i < count; i += 1) {
    const id = r.u8();
    if (seen.has(id)) {
      throw new Error(`pyth property ${String(id)} repeated`);
    }
    if (id === PROPERTY.price || id === PROPERTY.confidence) {
      seen.set(id, r.i64());
    } else if (id === PROPERTY.exponent) {
      seen.set(id, r.i16());
    } else {
      throw new Error(`pyth property ${String(id)} is not one settlement requests`);
    }
  }
  if (!r.done) {
    throw new Error("pyth payload has trailing bytes");
  }
  const price = seen.get(PROPERTY.price);
  const exponent = seen.get(PROPERTY.exponent);
  const confidence = seen.get(PROPERTY.confidence);
  if (typeof price !== "bigint" || price === 0n) {
    throw new Error("pyth payload has no price");
  }
  if (typeof exponent !== "number") {
    throw new Error("pyth payload has no exponent");
  }
  return {
    timestampUs,
    channel,
    feedId,
    price,
    exponent,
    confidence: typeof confidence === "bigint" && confidence !== 0n ? confidence : null,
  };
}

/** Decodes a SolanaMessage envelope and its payload; does not verify the signature. */
export function parseSolanaMessage(bytes: Uint8Array): SignedPythUpdate {
  const r = new Reader(bytes);
  if (r.u32() !== SOLANA_FORMAT_MAGIC) {
    throw new Error("pyth message is not in the solana format");
  }
  const signature = r.bytesOf(64);
  const publicKey = r.bytesOf(32);
  const payloadLength = r.u16();
  if (bytes.length !== ENVELOPE_LEN + payloadLength) {
    throw new Error("pyth message length does not match its payload length");
  }
  const payload = r.bytesOf(payloadLength);
  return { signature, publicKey, payload, parsed: parsePythPayload(payload) };
}

/** Ed25519 check of `update.signature` over `update.payload` by `update.publicKey`. */
export function signatureIsValid(update: SignedPythUpdate): boolean {
  // SPKI DER prefix for a raw 32-byte Ed25519 public key (RFC 8410).
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), update.publicKey]);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  return verify(null, update.payload, key, update.signature);
}

export interface CloseRules {
  /** Config `pyth_lazer_signer`, 32 bytes. */
  readonly signer: Uint8Array;
  /** Config `pyth_feed_ids` entry for the market's ticker. */
  readonly feedId: number;
  readonly closeTs: number;
  /** Config `pyth_max_age_secs`: the update must be taken by `closeTs + closeWindowSecs`. */
  readonly closeWindowSecs: number;
  /** Config `max_conf_bps`. */
  readonly maxConfBps: number;
  readonly nowSecs: number;
}

/**
 * The rules `settle_market` applies to a Pyth update (plus the signature, which the Ed25519
 * precompile checks on-chain). Throws naming the first broken rule.
 */
export function checkSignedClose(update: SignedPythUpdate, rules: CloseRules): void {
  const p = update.parsed;
  if (Buffer.compare(Buffer.from(update.publicKey), Buffer.from(rules.signer)) !== 0) {
    throw new Error("pyth update is not signed by the pinned pyth_lazer_signer");
  }
  if (!signatureIsValid(update)) {
    throw new Error("pyth update signature is invalid");
  }
  if (p.feedId !== rules.feedId) {
    throw new Error(`pyth feed ${String(p.feedId)} is not the pinned ${String(rules.feedId)}`);
  }
  if (p.price <= 0n) {
    throw new Error("pyth price is not positive");
  }
  const seconds = p.timestampUs / 1_000_000n;
  if (seconds < BigInt(rules.closeTs)) {
    throw new Error("pyth update was taken before close");
  }
  if (seconds > BigInt(rules.closeTs + rules.closeWindowSecs)) {
    throw new Error("pyth update was taken after the close window");
  }
  if (seconds > BigInt(rules.nowSecs)) {
    throw new Error("pyth update is in the future");
  }
  if (p.confidence === null || p.confidence <= 0n) {
    throw new Error("pyth update has no confidence");
  }
  if (p.confidence * BPS_DENOMINATOR > p.price * BigInt(rules.maxConfBps)) {
    throw new Error(
      `pyth confidence ${confidenceBps(p).toFixed(2)} bps is wider than ${String(rules.maxConfBps)} bps`,
    );
  }
}

/** Confidence as basis points of the price (for logs and errors only). */
export function confidenceBps(p: PythPayload): number {
  return p.confidence === null ? Number.POSITIVE_INFINITY : bpsOf(p.confidence, p.price);
}

function bpsOf(part: bigint, whole: bigint): number {
  return Number((part * 1_000_000n) / whole) / 100;
}

/** The price in integer cents, rounded half away from zero (logs and the official-close check). */
export function priceCents(p: PythPayload): bigint {
  const shift = p.exponent + 2;
  if (shift >= 0) {
    return p.price * 10n ** BigInt(shift);
  }
  const divisor = 10n ** BigInt(-shift);
  return (p.price * 2n + divisor) / (2n * divisor);
}

// ---- REST ----------------------------------------------------------------------------------

export type HttpPost = (
  url: string,
  init: {
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

const priceResponseSchema = z.object({
  solana: z.object({ encoding: z.literal("hex"), data: z.string().regex(/^[0-9a-f]+$/i) }),
});

export interface FetchSignedParams {
  readonly post: HttpPost;
  readonly token: string;
  readonly baseUrl: string;
  readonly feedId: number;
  readonly timestampUs: bigint;
  readonly timeoutMs?: number;
}

/** The solana-format update Pyth issued at `timestampUs` for one feed, decoded. */
export async function fetchSignedPrice(params: FetchSignedParams): Promise<SignedPythUpdate> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 10_000);
  const what = `pyth feed ${String(params.feedId)} at ${params.timestampUs.toString()}µs`;
  try {
    const response = await params.post(`${params.baseUrl}/v1/price`, {
      headers: {
        authorization: `Bearer ${params.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timestamp: Number(params.timestampUs),
        priceFeedIds: [params.feedId],
        properties: ["price", "exponent", "confidence"],
        formats: ["solana"],
        channel: PYTH_CHANNEL,
        jsonBinaryEncoding: "hex",
        parsed: false,
      }),
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new Error(`${what}: HTTP ${String(response.status)}${statusHint(response.status)}`);
    }
    const body = priceResponseSchema.safeParse(await response.json());
    if (!body.success) {
      throw new Error(`${what}: response has no hex solana update`);
    }
    return parseSolanaMessage(Uint8Array.from(Buffer.from(body.data.solana.data, "hex")));
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${what}: timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function statusHint(status: number): string {
  switch (status) {
    case 403:
      return " (token not entitled to this feed)";
    case 404:
      return " (no update at that time)";
    case 429:
      return " (rate limited)";
    default:
      return "";
  }
}
