// Pure-JS replacement for bigint-buffer@1.1.5, wired in with pnpm.overrides (D-037 pattern).
//
// GHSA-3gc7-fjrx-p6mg is a buffer overflow in bigint-buffer's native addon (`toBigIntLE`), with no
// fixed release. Upstream already ships a pure-JS path, used when the addon fails to load; this
// module is exactly that path with the addon removed, so the vulnerable C code is never installed.
// Same API and results as upstream's JS fallback. Consumer: @solana/buffer-layout-utils (u64/u128
// layouts), reached via @switchboard-xyz/on-demand > @solana/spl-token.
"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

/**
 * Little-endian buffer → BigInt.
 * @param {Buffer} buf
 * @returns {bigint}
 */
function toBigIntLE(buf) {
  const reversed = Buffer.from(buf);
  reversed.reverse();
  const hex = reversed.toString("hex");
  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`);
}

/**
 * Big-endian buffer → BigInt.
 * @param {Buffer} buf
 * @returns {bigint}
 */
function toBigIntBE(buf) {
  const hex = Buffer.from(buf).toString("hex");
  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`);
}

/**
 * BigInt → big-endian buffer of `width` bytes (truncated or zero-padded like upstream).
 * @param {bigint} num
 * @param {number} width
 * @returns {Buffer}
 */
function toBufferBE(num, width) {
  const hex = num.toString(16);
  return Buffer.from(hex.padStart(width * 2, "0").slice(0, width * 2), "hex");
}

/**
 * BigInt → little-endian buffer of `width` bytes.
 * @param {bigint} num
 * @param {number} width
 * @returns {Buffer}
 */
function toBufferLE(num, width) {
  const buffer = toBufferBE(num, width);
  buffer.reverse();
  return buffer;
}

exports.toBigIntLE = toBigIntLE;
exports.toBigIntBE = toBigIntBE;
exports.toBufferLE = toBufferLE;
exports.toBufferBE = toBufferBE;
