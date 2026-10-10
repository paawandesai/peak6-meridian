import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { load, save, reset } from "./storage";
import { registerDemoWallet } from "./wallet";

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

describe("demo-wallet registration guard (AC6)", () => {
  const originalEnv = process.env.NEXT_PUBLIC_CLUSTER;

  beforeEach(() => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_CLUSTER = originalEnv;
    vi.unstubAllGlobals();
  });

  it("registers the wallet when NEXT_PUBLIC_CLUSTER is devnet", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "devnet";
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      dispatchEvent,
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });

    registerDemoWallet();

    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "wallet-standard:register-wallet",
      }),
    );
  });

  it("does not register when NEXT_PUBLIC_CLUSTER is localnet (AC6: devnet only)", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "localnet";
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      dispatchEvent,
    });

    registerDemoWallet();

    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("does not register when NEXT_PUBLIC_CLUSTER is mainnet-beta", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "mainnet-beta";
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      dispatchEvent,
    });

    registerDemoWallet();

    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("does not register when NEXT_PUBLIC_CLUSTER is unset", () => {
    delete process.env.NEXT_PUBLIC_CLUSTER;
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      dispatchEvent,
    });

    registerDemoWallet();

    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
