import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE } from "./index.js";

describe("bigint-buffer pure-JS replacement", () => {
  it("matches known vectors", () => {
    const le = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    expect(toBigIntLE(le)).toBe(0x04030201n);
    expect(toBigIntBE(le)).toBe(0x01020304n);
    expect(toBigIntLE(Buffer.alloc(0))).toBe(0n);
    expect(toBigIntBE(Buffer.alloc(0))).toBe(0n);
    expect(toBufferLE(0x0102n, 4)).toEqual(Buffer.from([0x02, 0x01, 0, 0]));
    expect(toBufferBE(0x0102n, 4)).toEqual(Buffer.from([0, 0, 0x01, 0x02]));
  });

  it("matches upstream bigint-buffer@1.1.5's pure-JS path on every input (property)", () => {
    // Copied verbatim from bigint-buffer@1.1.5 dist/node.js (the branch taken without the addon),
    // including its truncation quirk for values wider than `width`.
    const upstream = {
      toBigIntLE(buf: Buffer): bigint {
        const reversed = Buffer.from(buf);
        reversed.reverse();
        const hex = reversed.toString("hex");
        return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`);
      },
      toBigIntBE(buf: Buffer): bigint {
        const hex = buf.toString("hex");
        return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`);
      },
      toBufferLE(num: bigint, width: number): Buffer {
        const hex = num.toString(16);
        const buffer = Buffer.from(hex.padStart(width * 2, "0").slice(0, width * 2), "hex");
        buffer.reverse();
        return buffer;
      },
      toBufferBE(num: bigint, width: number): Buffer {
        const hex = num.toString(16);
        return Buffer.from(hex.padStart(width * 2, "0").slice(0, width * 2), "hex");
      },
    };
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 40 }),
        fc.bigInt({ min: 0n, max: 1n << 300n }),
        fc.nat({ max: 40 }),
        (bytes, n, width) => {
          const buf = Buffer.from(bytes);
          expect(toBigIntLE(buf)).toBe(upstream.toBigIntLE(buf));
          expect(toBigIntBE(buf)).toBe(upstream.toBigIntBE(buf));
          expect(toBufferLE(n, width)).toEqual(upstream.toBufferLE(n, width));
          expect(toBufferBE(n, width)).toEqual(upstream.toBufferBE(n, width));
        },
      ),
    );
  });

  it("never reads past the input or writes past the width (property)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.nat({ max: 64 }), (bytes, width) => {
        const buf = Buffer.from(bytes);
        const le = toBigIntLE(buf);
        expect(le).toBeLessThan(1n << BigInt(8 * buf.length));
        expect(toBufferLE(le, width)).toHaveLength(width);
        expect(toBufferBE(toBigIntBE(buf), width)).toHaveLength(width);
      }),
    );
  });

  it("round-trips u64 values like @solana/buffer-layout-utils uses them (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (n) => {
        const le = toBufferLE(n, 8);
        expect(le.readBigUInt64LE(0)).toBe(n);
        expect(toBigIntLE(le)).toBe(n);
        expect(toBigIntBE(toBufferBE(n, 8))).toBe(n);
      }),
    );
  });

  it("round-trips u128 values (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), (n) => {
        const le = toBufferLE(n, 16);
        expect(le).toHaveLength(16);
        expect(toBigIntLE(le)).toBe(n);
        expect(toBigIntBE(toBufferBE(n, 16))).toBe(n);
      }),
    );
  });

  it("does not mutate its input", () => {
    const buf = Buffer.from([1, 2, 3]);
    toBigIntLE(buf);
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
  });
});
