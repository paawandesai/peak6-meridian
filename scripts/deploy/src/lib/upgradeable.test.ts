import { Keypair } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
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

describe("onChainElfMatches", () => {
  it("matches the stored ELF followed by padding", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 200 }),
        fc.nat({ max: 50 }),
        (elf, padding) => {
          const data = programDataAccount(1n, null, elf, padding);
          expect(onChainElfMatches(data, elf)).toBe(true);
        },
      ),
    );
  });

  it("does not match when the on-chain ELF is a longer, older build (padding-aware)", () => {
    const old = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const shorter = Uint8Array.from([1, 2, 3, 4]);
    expect(onChainElfMatches(programDataAccount(1n, null, old, 2), shorter)).toBe(false);
    expect(onChainElfMatches(programDataAccount(1n, null, shorter, 9), old)).toBe(false);
  });

  it("does not match a changed byte or a longer local ELF", () => {
    const elf = Uint8Array.from([1, 2, 3, 4]);
    const data = programDataAccount(1n, null, elf, 4);
    const changed = Uint8Array.from([1, 2, 9, 4]);
    expect(onChainElfMatches(data, changed)).toBe(false);
    expect(onChainElfMatches(data, new Uint8Array(100))).toBe(false);
  });
});
