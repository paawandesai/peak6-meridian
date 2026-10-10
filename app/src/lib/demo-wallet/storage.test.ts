import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { load, save, reset } from "./storage";
import { createOrLoadDemoWallet, registerDemoWallet } from "./wallet";

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

describe("demo-wallet StandardWalletAdapter compatibility", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("has supportedTransactionVersions on sign features (catches !83 crash)", () => {
    // The !83 crash: StandardWalletAdapter constructor reads
    // features['solana:signAndSendTransaction'].supportedTransactionVersions
    // and passes it to arraysEqual(a.length). Missing property → TypeError.
    const wallet = createOrLoadDemoWallet();

    // Verify both sign features have the required properties
    const signTx = wallet.features["solana:signTransaction"] as
      | { version: string; supportedTransactionVersions: readonly (string | number)[] }
      | undefined;
    expect(signTx).toBeDefined();
    expect(signTx?.version).toBe("1.0.0");
    expect(signTx?.supportedTransactionVersions).toBeDefined();
    expect(Array.isArray(signTx?.supportedTransactionVersions)).toBe(true);
    expect(signTx?.supportedTransactionVersions.length).toBeGreaterThan(0);
    expect(signTx?.supportedTransactionVersions).toContain("legacy");
    expect(signTx?.supportedTransactionVersions).toContain(0);

    const signAndSendTx = wallet.features["solana:signAndSendTransaction"] as
      | { version: string; supportedTransactionVersions: readonly (string | number)[] }
      | undefined;
    expect(signAndSendTx).toBeDefined();
    expect(signAndSendTx?.version).toBe("1.0.0");
    expect(signAndSendTx?.supportedTransactionVersions).toBeDefined();
    expect(Array.isArray(signAndSendTx?.supportedTransactionVersions)).toBe(true);
    expect(signAndSendTx?.supportedTransactionVersions.length).toBeGreaterThan(0);
    expect(signAndSendTx?.supportedTransactionVersions).toContain("legacy");
    expect(signAndSendTx?.supportedTransactionVersions).toContain(0);
  });

  it("has accounts as an array (even before connect)", () => {
    const wallet = createOrLoadDemoWallet();
    expect(wallet.accounts).toBeDefined();
    expect(Array.isArray(wallet.accounts)).toBe(true);
    expect(wallet.accounts.length).toBe(0);
  });

  it("has chains and features defined", () => {
    const wallet = createOrLoadDemoWallet();
    expect(wallet.chains).toBeDefined();
    expect(Array.isArray(wallet.chains)).toBe(true);
    expect(wallet.chains.length).toBeGreaterThan(0);
    expect(wallet.features).toBeDefined();
    expect(typeof wallet.features).toBe("object");
  });
});
