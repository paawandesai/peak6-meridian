import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { parseEnv, parseKeypair } from "./config";

const ENV = {
  SOLANA_RPC_URL: "http://127.0.0.1:8899",
  AUTOMATION_KEYPAIR: "[1]",
  SERVICE_TOKEN: "local-dev-token",
  TIINGO_API_KEY: "test-tiingo-key",
  TWELVEDATA_API_KEY: "test-twelvedata-key",
};

describe("parseEnv", () => {
  it("prefers MERIDIAN_DEVNET_RPC_URL over SOLANA_RPC_URL when set", () => {
    const url = "https://devnet.example/rpc";
    expect(parseEnv({ ...ENV, MERIDIAN_DEVNET_RPC_URL: url }).SOLANA_RPC_URL).toBe(url);
    expect(parseEnv({ ...ENV, MERIDIAN_DEVNET_RPC_URL: " " }).SOLANA_RPC_URL).toBe(
      ENV.SOLANA_RPC_URL,
    );
  });

  it("fills defaults and treats empty optionals as unset", () => {
    expect(
      parseEnv({ ...ENV, ALERT_WEBHOOK_URL: "", MERIDIAN_PROGRAM_ID: "", PORT: "" }),
    ).toMatchObject({
      PORT: 4000,
      ALERT_WEBHOOK_URL: undefined,
      MERIDIAN_PROGRAM_ID: undefined,
    });
    expect(
      parseEnv({ ...ENV, PORT: "4123", ALERT_WEBHOOK_URL: "https://hooks.example/x" }).PORT,
    ).toBe(4123);
  });

  it("treats AUTOMATION_KEYPAIR as optional (a missing key degrades the service, AC5b)", () => {
    const withoutKey: Record<string, string> = { ...ENV };
    delete withoutKey.AUTOMATION_KEYPAIR;
    expect(parseEnv(withoutKey).AUTOMATION_KEYPAIR).toBeUndefined();
    expect(parseEnv({ ...ENV, AUTOMATION_KEYPAIR: "" }).AUTOMATION_KEYPAIR).toBeUndefined();
  });

  it("names the broken variables and never echoes their values", () => {
    const bad = { ...ENV, SERVICE_TOKEN: "short", SOLANA_RPC_URL: "not a url secret-ish" };
    expect(() => parseEnv(bad)).toThrow(/SERVICE_TOKEN/);
    try {
      parseEnv(bad);
    } catch (error) {
      expect(String(error)).toContain("SOLANA_RPC_URL");
      expect(String(error)).not.toContain("short");
      expect(String(error)).not.toContain("secret-ish");
    }
    expect(() => parseEnv({})).toThrow(/invalid environment/);
  });

  it("caps settlement data-API requests per run at 8 by default, configurable within 4..100 (#53)", () => {
    expect(parseEnv(ENV).SETTLE_MAX_API_CALLS_PER_RUN).toBe(8);
    expect(
      parseEnv({ ...ENV, SETTLE_MAX_API_CALLS_PER_RUN: "" }).SETTLE_MAX_API_CALLS_PER_RUN,
    ).toBe(8);
    expect(
      parseEnv({ ...ENV, SETTLE_MAX_API_CALLS_PER_RUN: "12" }).SETTLE_MAX_API_CALLS_PER_RUN,
    ).toBe(12);
    for (const bad of ["2", "0", "101", "8.5", "lots"]) {
      expect(() => parseEnv({ ...ENV, SETTLE_MAX_API_CALLS_PER_RUN: bad })).toThrow(
        /SETTLE_MAX_API_CALLS_PER_RUN/,
      );
    }
  });
});

describe("parseKeypair", () => {
  it("parses a JSON secret key", () => {
    const keypair = Keypair.generate();
    const parsed = parseKeypair(JSON.stringify(Array.from(keypair.secretKey)));
    expect(parsed.publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("rejects anything else without revealing it", () => {
    for (const text of [
      "",
      "not json",
      "[1,2,3]",
      JSON.stringify(Array(64).fill(300)),
      '{"a":1}',
    ]) {
      expect(() => parseKeypair(text)).toThrow(/AUTOMATION_KEYPAIR/);
    }
    try {
      parseKeypair("[7,7,7,7]");
    } catch (error) {
      expect(String(error)).not.toContain("7,7");
    }
  });

  it("rejects 64 bytes that are not a keypair", () => {
    expect(() => parseKeypair(JSON.stringify(Array(64).fill(1)))).toThrow(/AUTOMATION_KEYPAIR/);
  });
});
