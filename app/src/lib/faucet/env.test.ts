// @vitest-environment node
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_COOLDOWN_SEC,
  DEFAULT_AMOUNT_USDC,
  DEFAULT_MIN_LAMPORTS,
  FaucetConfigError,
  parseFaucetEnv,
} from "./env";

const keypair = Keypair.generate();
const base = {
  FAUCET_KEYPAIR: JSON.stringify(Array.from(keypair.secretKey)),
  USDC_MINT: Keypair.generate().publicKey.toBase58(),
  SOLANA_RPC_URL: "http://127.0.0.1:8899",
};

describe("parseFaucetEnv", () => {
  it("parses a minimal environment with the documented defaults", () => {
    const settings = parseFaucetEnv(base);
    expect(settings.keypair.publicKey.equals(keypair.publicKey)).toBe(true);
    expect(settings.amountBaseUnits).toBe(DEFAULT_AMOUNT_USDC * 1_000_000n);
    expect(settings.minLamports).toBe(DEFAULT_MIN_LAMPORTS);
    expect(settings.alertCooldownMs).toBe(DEFAULT_ALERT_COOLDOWN_SEC * 1000);
    expect(settings.alertWebhookUrl).toBeUndefined();
    expect(settings.cluster).toBeUndefined();
  });

  it("reads every override", () => {
    const settings = parseFaucetEnv({
      ...base,
      FAUCET_AMOUNT_USDC: "25",
      FAUCET_MIN_LAMPORTS: "5",
      FAUCET_ALERT_COOLDOWN_SEC: "60",
      ALERT_WEBHOOK_URL: " https://hooks.example/abc ",
      SOLANA_CLUSTER: "localnet",
    });
    expect(settings.amountBaseUnits).toBe(25_000_000n);
    expect(settings.minLamports).toBe(5n);
    expect(settings.alertCooldownMs).toBe(60_000);
    expect(settings.alertWebhookUrl).toBe("https://hooks.example/abc");
    expect(settings.cluster).toBe("localnet");
  });

  it("names the variable but never echoes a key or any value of the keypair", () => {
    for (const bad of ["", "not json", "[1,2,3]", JSON.stringify(Array(64).fill("x"))]) {
      let message = "";
      try {
        parseFaucetEnv({ ...base, FAUCET_KEYPAIR: bad });
      } catch (error) {
        expect(error).toBeInstanceOf(FaucetConfigError);
        message = (error as Error).message;
      }
      expect(message).toContain("FAUCET_KEYPAIR");
      if (bad !== "") expect(message).not.toContain(bad);
    }
  });

  it("rejects a missing or malformed mint, RPC URL, amount, floor and cooldown", () => {
    expect(() => parseFaucetEnv({ ...base, USDC_MINT: undefined })).toThrow("USDC_MINT");
    expect(() => parseFaucetEnv({ ...base, USDC_MINT: "nope" })).toThrow("USDC_MINT");
    expect(() => parseFaucetEnv({ ...base, SOLANA_RPC_URL: " " })).toThrow("SOLANA_RPC_URL");
    expect(() => parseFaucetEnv({ ...base, FAUCET_AMOUNT_USDC: "0" })).toThrow(
      "FAUCET_AMOUNT_USDC",
    );
    expect(() => parseFaucetEnv({ ...base, FAUCET_AMOUNT_USDC: "1.5" })).toThrow(
      "FAUCET_AMOUNT_USDC",
    );
    expect(() => parseFaucetEnv({ ...base, FAUCET_MIN_LAMPORTS: "0.1" })).toThrow(
      "FAUCET_MIN_LAMPORTS",
    );
    expect(() => parseFaucetEnv({ ...base, FAUCET_ALERT_COOLDOWN_SEC: "-1" })).toThrow(
      "FAUCET_ALERT_COOLDOWN_SEC",
    );
  });
});
