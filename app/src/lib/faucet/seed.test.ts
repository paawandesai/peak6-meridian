// @vitest-environment node
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { dayBucket, markerAddress, markerSeed, SECONDS_PER_DAY } from "./seed";

describe("markerSeed", () => {
  const key = new PublicKey(new Uint8Array(32).fill(7));

  it("is the first 32 hex chars of sha256(pubkey || bucket u64 LE) (known answer)", () => {
    expect(markerSeed(key, 20_000n)).toBe("26886d3772882b91f1d417d9e3447cc0");
  });

  it("is 32 lowercase hex characters, a valid account seed, and differs per bucket and wallet (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), (bucket) => {
        const seed = markerSeed(key, bucket);
        expect(seed).toMatch(/^[0-9a-f]{32}$/);
        expect(markerSeed(key, bucket + 1n)).not.toBe(seed);
        expect(markerSeed(Keypair.generate().publicKey, bucket)).not.toBe(seed);
      }),
    );
  });
});

describe("markerAddress", () => {
  it("is createWithSeed(base, seed, SystemProgram)", async () => {
    const base = Keypair.generate().publicKey;
    const wallet = Keypair.generate().publicKey;
    const expected = await PublicKey.createWithSeed(
      base,
      markerSeed(wallet, 5n),
      SystemProgram.programId,
    );
    expect((await markerAddress(base, wallet, 5n)).equals(expected)).toBe(true);
  });
});

describe("dayBucket", () => {
  it("is floor(unix / 86400) and rejects non-timestamps", () => {
    expect(dayBucket(0)).toBe(0n);
    expect(dayBucket(SECONDS_PER_DAY - 1)).toBe(0n);
    expect(dayBucket(SECONDS_PER_DAY)).toBe(1n);
    expect(() => dayBucket(-1)).toThrow();
    expect(() => dayBucket(1.5)).toThrow();
  });
});
