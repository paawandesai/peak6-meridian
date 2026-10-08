import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { assertProgramIds, declaredIdFromLibRs, idlAddress } from "./program-id";

const id = Keypair.generate().publicKey;

describe("declaredIdFromLibRs", () => {
  it("finds the declared ID", () => {
    const source = `use anchor_lang::prelude::*;\n\ndeclare_id!("${id.toBase58()}");\n`;
    expect(declaredIdFromLibRs(source)).toBe(id.toBase58());
  });

  it("returns null when absent", () => {
    expect(declaredIdFromLibRs("pub fn main() {}")).toBeNull();
  });
});

describe("idlAddress", () => {
  it("reads the address", () => {
    expect(idlAddress(JSON.stringify({ address: id.toBase58() }))).toBe(id.toBase58());
  });

  it("returns null without an address", () => {
    expect(idlAddress("{}")).toBeNull();
    expect(idlAddress("[]")).toBeNull();
    expect(idlAddress(JSON.stringify({ address: 5 }))).toBeNull();
  });
});

describe("assertProgramIds", () => {
  const same = id.toBase58();

  it("passes when every known source matches", () => {
    expect(() =>
      assertProgramIds({ keypair: id, declared: same, idl: same, env: same }),
    ).not.toThrow();
  });

  it("skips sources that are not set or not built yet", () => {
    expect(() => assertProgramIds({ keypair: id, declared: same })).not.toThrow();
  });

  it("fails naming each mismatching source, and says nothing was sent", () => {
    const other = Keypair.generate().publicKey.toBase58();
    expect(() => assertProgramIds({ keypair: id, declared: other, idl: same, env: other })).toThrow(
      /declare_id!.*MERIDIAN_PROGRAM_ID.*Nothing was sent/s,
    );
    expect(() => assertProgramIds({ keypair: id, declared: same, idl: other })).toThrow(
      /IDL address/,
    );
  });

  it("fails when the declared ID or IDL address is missing", () => {
    expect(() => assertProgramIds({ keypair: id, declared: null })).toThrow(/is missing/);
    expect(() => assertProgramIds({ keypair: id, declared: same, idl: null })).toThrow(
      /IDL address.*is missing/,
    );
  });
});
