// @vitest-environment node
import { DEVNET_GENESIS_HASH, MAINNET_BETA_GENESIS_HASH } from "@meridian/client";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { FakeFaucetChain } from "./fake-chain";
import { ALREADY_CLAIMED_MESSAGE, createFaucet, isMarkerConflict } from "./faucet";
import { SECONDS_PER_DAY } from "./seed";

const AMOUNT = 5_000_000n;

function setup(extra: { alertThrows?: boolean } = {}) {
  const keypair = Keypair.generate();
  const chain = new FakeFaucetChain();
  chain.mintAuthority = keypair.publicKey;
  chain.unixTime = 20_000 * SECONDS_PER_DAY + 3_600;
  const logs: Record<string, string | number>[] = [];
  const alerts: string[] = [];
  let now = 1_000;
  const faucet = createFaucet({
    chain,
    keypair,
    mint: Keypair.generate().publicKey,
    amountBaseUnits: AMOUNT,
    minLamports: 100n,
    cluster: "devnet",
    rpcUrl: "https://devnet.example/?api-key=SECRET123",
    alert: (text) => {
      if (extra.alertThrows === true) {
        return Promise.reject(new Error("POST https://hooks.example/SECRETHOOK failed"));
      }
      alerts.push(text);
      return Promise.resolve();
    },
    alertCooldownMs: 10_000,
    now: () => now,
    log: (entry) => logs.push(entry),
  });
  return { faucet, chain, logs, alerts, advance: (ms: number) => (now += ms) };
}

const wallet = () => Keypair.generate().publicKey.toBase58();

describe("createFaucet.claim", () => {
  it("mints the fixed amount once and refuses a repeat with the 24 h message", async () => {
    const { faucet, chain } = setup();
    const w = wallet();
    expect(await faucet.claim(w)).toMatchObject({ status: 200, amountBaseUnits: AMOUNT });
    expect(await faucet.claim(w)).toEqual({ status: 429, error: ALREADY_CLAIMED_MESSAGE });
    expect(chain.mints).toEqual([expect.objectContaining({ amount: AMOUNT })]);
    expect(ALREADY_CLAIMED_MESSAGE).toContain("24 hours");
  });

  it("rejects invalid and off-curve addresses with 400 before any RPC call", async () => {
    const { faucet, chain } = setup();
    for (const bad of [
      "",
      "nope",
      "0".repeat(44),
      "11111111111111111111111111111111111111111111",
    ]) {
      expect((await faucet.claim(bad)).status).toBe(400);
    }
    // A program-derived address is a valid key but off the curve: it cannot own a token account.
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("x")], SystemProgram.programId);
    expect((await faucet.claim(pda.toBase58())).status).toBe(400);
    expect(chain.simulations).toBe(0);
  });

  it("refuses a non-devnet cluster and an unreachable RPC, without leaking the URL", async () => {
    const mainnet = setup();
    mainnet.chain.genesisHash = MAINNET_BETA_GENESIS_HASH;
    expect((await mainnet.faucet.claim(wallet())).status).toBe(503);
    const down = setup();
    down.chain.genesisError = new Error("fetch failed https://devnet.example/?api-key=SECRET123");
    const result = await down.faucet.claim(wallet());
    expect(result.status).toBe(503);
    expect(JSON.stringify({ result, logs: down.logs })).not.toContain("SECRET123");
    const ok = setup();
    ok.chain.genesisHash = DEVNET_GENESIS_HASH;
    expect((await ok.faucet.claim(wallet())).status).toBe(200);
  });

  it("answers 500 for a key that is not the mint authority and 502 when the mint is unreadable", async () => {
    const wrong = setup();
    wrong.chain.mintAuthority = Keypair.generate().publicKey;
    expect(await wrong.faucet.claim(wallet())).toMatchObject({
      status: 500,
      error: expect.stringContaining("mint authority"),
    });
    const unset = setup();
    unset.chain.mintAuthority = null;
    expect((await unset.faucet.claim(wallet())).status).toBe(500);
    const broken = setup();
    broken.chain.getMintAuthority = () => Promise.reject(new Error("rpc down"));
    expect((await broken.faucet.claim(wallet())).status).toBe(502);
  });

  it("below the floor: 503, one alert per cooldown, alert failure logged by class only", async () => {
    const { faucet, chain, alerts, advance } = setup();
    chain.balance = 99;
    expect((await faucet.claim(wallet())).status).toBe(503);
    expect((await faucet.claim(wallet())).status).toBe(503);
    expect(alerts).toHaveLength(1);
    advance(10_000);
    await faucet.claim(wallet());
    expect(alerts).toHaveLength(2);
    expect(chain.mints).toHaveLength(0);

    const failing = setup({ alertThrows: true });
    failing.chain.balance = 0;
    expect((await failing.faucet.claim(wallet())).status).toBe(503);
    expect(failing.logs).toContainEqual({ event: "faucet_alert_failed", reason: "Error" });
    expect(JSON.stringify(failing.logs)).not.toContain("SECRETHOOK");
  });

  it("maps an unexpected failure to 502 and never to 429", async () => {
    const atCreation = setup();
    atCreation.chain.ataFailsWith = 0;
    expect((await atCreation.faucet.claim(wallet())).status).toBe(502);
    const throwing = setup();
    throwing.chain.getBalance = () => Promise.reject(new TypeError("boom https://x/SECRET123"));
    const result = await throwing.faucet.claim(wallet());
    expect(result.status).toBe(502);
    expect(JSON.stringify(throwing.logs)).not.toContain("SECRET123");
    expect(throwing.logs).toContainEqual({ event: "faucet_error", reason: "TypeError" });
  });

  it("an expired transaction is a 502 (not rebroadcast) and the next attempt can succeed", async () => {
    const { faucet, chain } = setup();
    const w = wallet();
    chain.expireNext = true;
    expect((await faucet.claim(w)).status).toBe(502);
    expect(chain.sentSignatures).toHaveLength(1);
    expect((await faucet.claim(w)).status).toBe(200);
  });
});

describe("isMarkerConflict", () => {
  it("is true only for custom error 0 at a marker instruction index", () => {
    const err = (index: number, custom: unknown) => ({ InstructionError: [index, custom] });
    expect(isMarkerConflict(err(1, { Custom: 0 }), [1, 3])).toBe(true);
    expect(isMarkerConflict(err(2, { Custom: 0 }), [1, 3])).toBe(false);
    expect(isMarkerConflict(err(1, { Custom: 7 }), [1, 3])).toBe(false);
    expect(isMarkerConflict(err(1, "GenericError"), [1, 3])).toBe(false);
    expect(isMarkerConflict({ InstructionError: "bad" }, [1])).toBe(false);
    expect(isMarkerConflict(undefined, [1])).toBe(false);
  });
});
