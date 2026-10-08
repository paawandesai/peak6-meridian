// @vitest-environment node
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { createFaucetFromEnv, webhookAlerter } from "./instance";

describe("webhookAlerter", () => {
  it("POSTs the text as JSON to the webhook with a timeout", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    await webhookAlerter("https://hooks.example/abc", fetcher)("low balance");
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example/abc");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      content: "low balance",
      text: "low balance",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does nothing without a webhook URL and throws on a bad status", async () => {
    const fetcher = vi.fn();
    await webhookAlerter(undefined, fetcher)("x");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      webhookAlerter("https://hooks.example/abc", () =>
        Promise.resolve(new Response("", { status: 500 })),
      )("x"),
    ).rejects.toThrow("webhook status 500");
  });
});

describe("createFaucetFromEnv", () => {
  it("builds a faucet from a valid environment and refuses an invalid one", async () => {
    const env = {
      FAUCET_KEYPAIR: JSON.stringify(Array.from(Keypair.generate().secretKey)),
      USDC_MINT: Keypair.generate().publicKey.toBase58(),
      SOLANA_RPC_URL: "http://127.0.0.1:1",
      SOLANA_CLUSTER: "localnet",
    };
    const logs: unknown[] = [];
    const faucet = createFaucetFromEnv(env, { log: (entry) => logs.push(entry) });
    // An invalid wallet is rejected before any RPC call, so no network is needed here.
    expect((await faucet.claim("nope")).status).toBe(400);
    expect(() => createFaucetFromEnv({ ...env, FAUCET_KEYPAIR: undefined })).toThrow(
      "FAUCET_KEYPAIR",
    );
  });
});
