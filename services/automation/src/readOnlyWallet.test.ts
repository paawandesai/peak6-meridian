import { PublicKey, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { READ_ONLY_ERROR, readOnlyWallet } from "./readOnlyWallet";

describe("readOnlyWallet (AB-19)", () => {
  it("has the default public key", () => {
    expect(readOnlyWallet().publicKey.equals(PublicKey.default)).toBe(true);
  });

  it("rejects signing one transaction", async () => {
    await expect(readOnlyWallet().signTransaction(new Transaction())).rejects.toThrow(
      READ_ONLY_ERROR,
    );
  });

  it("rejects signing several transactions", async () => {
    await expect(
      readOnlyWallet().signAllTransactions([new Transaction(), new Transaction()]),
    ).rejects.toThrow(READ_ONLY_ERROR);
  });
});
