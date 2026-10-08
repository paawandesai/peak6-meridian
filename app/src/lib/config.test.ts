import { MERIDIAN_PROGRAM_ID } from "@meridian/client";
import { describe, expect, it } from "vitest";

import { loadPublicConfig, parsePublicConfig } from "./config";

const MINT = "11111111111111111111111111111112";

describe("parsePublicConfig", () => {
  it("defaults to a local validator and the IDL program", () => {
    const config = parsePublicConfig({});
    expect(config.cluster).toBe("localnet");
    expect(config.rpcUrl).toBe("http://127.0.0.1:8899");
    expect(config.programId.equals(MERIDIAN_PROGRAM_ID)).toBe(true);
    expect(config.usdcMint).toBeUndefined();
  });

  it("treats empty strings (blank .env lines) as unset", () => {
    const config = parsePublicConfig({ programId: "", usdcMint: " ", rpcUrl: "" });
    expect(config.usdcMint).toBeUndefined();
    expect(config.rpcUrl).toBe("http://127.0.0.1:8899");
  });

  it("parses explicit values", () => {
    const config = parsePublicConfig({
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      usdcMint: MINT,
    });
    expect(config.cluster).toBe("devnet");
    expect(config.usdcMint?.toBase58()).toBe(MINT);
  });

  it.each([
    [{ cluster: "mainnet-beta" }],
    [{ rpcUrl: "not a url" }],
    [{ programId: "nope" }],
    [{ usdcMint: "0OIl" }],
  ])("rejects %j with context", (raw) => {
    expect(() => parsePublicConfig(raw)).toThrow(/invalid NEXT_PUBLIC_\* configuration/);
  });
});

describe("loadPublicConfig", () => {
  it("reads NEXT_PUBLIC_* variables only", () => {
    const original = { ...process.env };
    try {
      process.env.NEXT_PUBLIC_USDC_MINT = MINT;
      process.env.USDC_MINT = "ignored-server-name";
      expect(loadPublicConfig().usdcMint?.toBase58()).toBe(MINT);
    } finally {
      process.env = original;
    }
  });
});
