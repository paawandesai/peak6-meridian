import { Keypair } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  extendBytesNeeded,
  MIN_EXTEND_BYTES,
  onChainElfMatches,
  PROGRAM_DATA_HEADER_LEN,
  programDataAddress,
  programDataHeader,
} from "./upgradeable";

function programAccount(programData: Uint8Array): Uint8Array {
  const data = new Uint8Array(36);
  new DataView(data.buffer).setUint32(0, 2, true);
  data.set(programData, 4);
  return data;
}

function programDataAccount(
  slot: bigint,
  authority: Uint8Array | null,
  elf: Uint8Array,
  padding = 0,
): Uint8Array {
  const data = new Uint8Array(PROGRAM_DATA_HEADER_LEN + elf.length + padding);
  const view = new DataView(data.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, slot, true);
  if (authority !== null) {
    data[12] = 1;
    data.set(authority, 13);
  }
  data.set(elf, PROGRAM_DATA_HEADER_LEN);
  return data;
}

describe("programDataAddress", () => {
  it("reads the ProgramData address from a Program account", () => {
    const address = Keypair.generate().publicKey;
    expect(programDataAddress(programAccount(address.toBytes()))?.equals(address)).toBe(true);
  });

  it("returns null for other account shapes", () => {
    expect(programDataAddress(new Uint8Array(10))).toBeNull();
    expect(programDataAddress(new Uint8Array(36))).toBeNull();
  });
});

describe("programDataHeader", () => {
  it("reads slot and authority", () => {
    const authority = Keypair.generate().publicKey;
    const header = programDataHeader(
      programDataAccount(42n, authority.toBytes(), new Uint8Array(3)),
    );
    expect(header?.slot).toBe(42n);
    expect(header?.authority?.equals(authority)).toBe(true);
  });

  it("reports an immutable program as having no authority", () => {
    expect(
      programDataHeader(programDataAccount(1n, null, new Uint8Array(1)))?.authority,
    ).toBeNull();
  });

  it("returns null for the wrong tag, a short account or a bad option byte", () => {
    expect(programDataHeader(new Uint8Array(10))).toBeNull();
    expect(programDataHeader(new Uint8Array(PROGRAM_DATA_HEADER_LEN))).toBeNull();
    const bad = programDataAccount(1n, null, new Uint8Array(1));
    bad[12] = 2;
    expect(programDataHeader(bad)).toBeNull();
  });
});

describe("onChainElfMatches (the exact comparison rule)", () => {
  it("matches the stored ELF followed by zero padding (property)", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 200 }),
        fc.nat({ max: 50 }),
        (elf, padding) => {
          expect(onChainElfMatches(programDataAccount(1n, null, elf, padding), elf)).toBe(true);
        },
      ),
    );
  });

  it("matches a .so whose own last bytes are zero (nothing is trimmed)", () => {
    const elf = Uint8Array.from([7, 8, 9, 0, 0]);
    expect(onChainElfMatches(programDataAccount(1n, null, elf, 6), elf)).toBe(true);
    // ...but a same-prefix on-chain buffer with a non-zero tail is a different program.
    const tail = programDataAccount(1n, null, elf, 6);
    tail[tail.length - 1] = 1;
    expect(onChainElfMatches(tail, elf)).toBe(false);
  });

  it("does not match a non-zero padded tail (an older, longer build)", () => {
    const old = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const shorter = Uint8Array.from([1, 2, 3, 4]);
    expect(onChainElfMatches(programDataAccount(1n, null, old, 2), shorter)).toBe(false);
  });

  it("does not match a short on-chain buffer (len < built_len)", () => {
    const built = Uint8Array.from([1, 2, 3, 4]);
    expect(onChainElfMatches(programDataAccount(1n, null, built.slice(0, 2)), built)).toBe(false);
    expect(onChainElfMatches(new Uint8Array(10), built)).toBe(false);
  });

  it("starts comparing after the 45-byte header, not before", () => {
    const built = Uint8Array.from([5, 5, 5]);
    const data = programDataAccount(1n, null, built);
    expect(PROGRAM_DATA_HEADER_LEN).toBe(45);
    expect(onChainElfMatches(data, built)).toBe(true);
    // a built ELF equal to the header bytes' continuation would only match at offset 45
    const shifted = new Uint8Array(data.length + 1);
    shifted.set(data, 1);
    expect(onChainElfMatches(shifted, built)).toBe(false);
  });

  it("does not match a changed byte", () => {
    const elf = Uint8Array.from([1, 2, 3, 4]);
    expect(
      onChainElfMatches(programDataAccount(1n, null, elf, 4), Uint8Array.from([1, 2, 9, 4])),
    ).toBe(false);
  });
});

describe("extendBytesNeeded", () => {
  it("is 0 when the build fits the ProgramData account", () => {
    expect(extendBytesNeeded(PROGRAM_DATA_HEADER_LEN + 1_000, 1_000)).toBe(0);
    expect(extendBytesNeeded(PROGRAM_DATA_HEADER_LEN + 1_000, 900)).toBe(0);
  });

  it("extends by at least MIN_EXTEND_BYTES for a small shortfall", () => {
    expect(extendBytesNeeded(PROGRAM_DATA_HEADER_LEN + 1_000, 1_001)).toBe(MIN_EXTEND_BYTES);
  });

  it("extends by exactly the shortfall when it is larger than the minimum", () => {
    expect(extendBytesNeeded(PROGRAM_DATA_HEADER_LEN + 1_000, 1_000 + 50_000)).toBe(50_000);
  });

  it("treats an account shorter than the header as holding nothing", () => {
    expect(extendBytesNeeded(10, 20_000)).toBe(20_000);
  });

  it("after extending, the build always fits, and 0 means it already did (property)", () => {
    fc.assert(
      fc.property(fc.nat(2_000_000), fc.nat(2_000_000), (capacity, built) => {
        const extend = extendBytesNeeded(PROGRAM_DATA_HEADER_LEN + capacity, built);
        if (built <= capacity) {
          expect(extend).toBe(0);
        } else {
          expect(extend).toBeGreaterThanOrEqual(MIN_EXTEND_BYTES);
          expect(capacity + extend).toBeGreaterThanOrEqual(built);
          expect(extend).toBe(Math.max(built - capacity, MIN_EXTEND_BYTES));
        }
      }),
    );
  });
});
