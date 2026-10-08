import { describe, expect, it } from "vitest";

import { assertNoLocalOracle, sha256Hex } from "./artifacts";

const idl = (...names: string[]) =>
  JSON.stringify({ instructions: names.map((name) => ({ name })) });

describe("assertNoLocalOracle (AB-22)", () => {
  it("accepts a devnet IDL", () => {
    expect(() => assertNoLocalOracle(idl("settle_market", "mint_pair"))).not.toThrow();
  });

  it("rejects an IDL that lists local_oracle_set before anything is sent", () => {
    expect(() => assertNoLocalOracle(idl("settle_market", "local_oracle_set"))).toThrow(
      /local-oracle build.*Nothing was sent/s,
    );
  });

  it("rejects something that is not a Meridian IDL", () => {
    expect(() => assertNoLocalOracle(idl("transfer"))).toThrow(/does not look like Meridian/);
    expect(() => assertNoLocalOracle("{}")).toThrow(/no instructions list/);
  });
});

describe("sha256Hex", () => {
  it("hashes bytes", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
