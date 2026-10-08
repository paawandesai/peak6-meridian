import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { APP_ENV, assertComplete, collectEnv, redactSecrets, requestJson } from "./platform";

describe("redactSecrets", () => {
  it("removes every secret value and keeps short strings alone", () => {
    expect(redactSecrets("token=abcdef123 and abcdef123", ["abcdef123"])).toBe("token=*** and ***");
    expect(redactSecrets("a b c", ["a"])).toBe("a b c");
  });

  it("never leaves a secret in the output (property)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 6, maxLength: 20 }), fc.string(), (secret, noise) => {
        const out = redactSecrets(`${noise}${secret}${noise}`, [secret]);
        expect(out.includes(secret)).toBe(false);
      }),
    );
  });
});

describe("collectEnv", () => {
  it("separates present, blank and missing variables and fails naming only the names", () => {
    const env = { NEXT_PUBLIC_CLUSTER: "devnet", SOLANA_CLUSTER: "  ", FAUCET_KEYPAIR: "[1,2,3]" };
    const collected = collectEnv(APP_ENV, env);
    expect(Object.keys(collected.values).sort()).toEqual(["FAUCET_KEYPAIR", "NEXT_PUBLIC_CLUSTER"]);
    expect(collected.missingRequired).toContain("SOLANA_CLUSTER");
    expect(collected.missingOptional).toContain("FINNHUB_API_KEY");
    let message = "";
    try {
      assertComplete("vercel", collected);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("SOLANA_CLUSTER");
    expect(message).not.toContain("[1,2,3]");
  });
});

describe("requestJson", () => {
  it("returns status and parsed body, null for non-JSON", async () => {
    const ok = await requestJson({ fetch: async () => new Response('{"a":1}') }, "x", "u", {}, []);
    expect(ok).toEqual({ status: 200, body: { a: 1 } });
    const bad = await requestJson({ fetch: async () => new Response("<html>") }, "x", "u", {}, []);
    expect(bad.body).toBeNull();
  });

  it("redacts the token from a network error", async () => {
    const fetch = async () => {
      throw new Error("connect failed for Bearer SECRETTOKEN");
    };
    await expect(requestJson({ fetch }, "vercel GET", "u", {}, ["SECRETTOKEN"])).rejects.toThrow(
      /vercel GET: request failed \(connect failed for Bearer \*\*\*\)/,
    );
  });
});
