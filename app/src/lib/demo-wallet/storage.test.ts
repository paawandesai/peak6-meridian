import { describe, it, expect, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import { load, save, reset } from "./storage";

describe("demo-wallet storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when no wallet stored", () => {
    expect(load()).toBeNull();
  });

  it("saves and loads a keypair", () => {
    const kp = Keypair.generate();
    save(kp);
    const loaded = load();
    expect(loaded?.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("reset removes the wallet", () => {
    save(Keypair.generate());
    reset();
    expect(load()).toBeNull();
  });
});
