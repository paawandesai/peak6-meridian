// @vitest-environment node
import { DEVNET_GENESIS_HASH, MAINNET_BETA_GENESIS_HASH } from "@meridian/client";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemInstruction, SystemProgram } from "@solana/web3.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { FakeFaucetChain } from "./fake-chain";
import {
  ALREADY_CLAIMED_MESSAGE,
  buildClaim,
  createFaucet,
  isMarkerConflict,
  planFeeSol,
} from "./faucet";
import { FEE_SOL_LAMPORTS, FEE_SOL_THRESHOLD_LAMPORTS } from "./response";
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
  return { faucet, chain, keypair, logs, alerts, advance: (ms: number) => (now += ms) };
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

/** The system transfers of a transaction, decoded, with their instruction index. */
function transfers(tx: { instructions: readonly { programId: PublicKey; data: Buffer }[] }) {
  return tx.instructions.flatMap((ix, index) => {
    if (!ix.programId.equals(SystemProgram.programId)) return [];
    const typed = ix as Parameters<typeof SystemInstruction.decodeInstructionType>[0];
    if (SystemInstruction.decodeInstructionType(typed) !== "Transfer") return [];
    return [{ index, ...SystemInstruction.decodeTransfer(typed) }];
  });
}

const mintIndex = (tx: { instructions: readonly { programId: PublicKey; data: Buffer }[] }) =>
  tx.instructions.findIndex((ix) => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 7);

describe("buildClaim fee SOL", () => {
  const blockhash = {
    blockhash: new PublicKey(new Uint8Array(32).fill(3)).toBase58(),
    lastValidBlockHeight: 9,
  };

  async function build(feeSolLamports: bigint) {
    const keypair = Keypair.generate();
    const claimant = Keypair.generate().publicKey;
    const built = await buildClaim(
      {
        chain: new FakeFaucetChain(),
        keypair,
        mint: Keypair.generate().publicKey,
        amountBaseUnits: AMOUNT,
      },
      claimant,
      20_000n,
      blockhash,
      feeSolLamports,
    );
    return { ...built, keypair, claimant };
  }

  it("adds exactly one faucet-to-claimant transfer of the exact lamports, after the mint, in the same transaction", async () => {
    const { tx, keypair, claimant, markerIndexes } = await build(FEE_SOL_LAMPORTS);
    const toClaimant = transfers(tx).filter((t) => t.toPubkey.equals(claimant));
    expect(toClaimant).toHaveLength(1);
    const [fee] = toClaimant;
    expect(fee?.fromPubkey.equals(keypair.publicKey)).toBe(true);
    expect(fee?.lamports).toBe(FEE_SOL_LAMPORTS);
    expect(mintIndex(tx)).toBeGreaterThan(-1);
    expect(fee?.index).toBeGreaterThan(mintIndex(tx));
    // The markers keep their positions, so a repeat claim is still recognised as one.
    expect(markerIndexes).toEqual([1, 3]);
    expect(tx.feePayer?.equals(keypair.publicKey)).toBe(true);
  });

  it("adds no transfer to the claimant when no fee SOL is planned", async () => {
    const { tx, claimant } = await build(0n);
    expect(transfers(tx).filter((t) => t.toPubkey.equals(claimant))).toHaveLength(0);
    // Only the two marker rent transfers remain.
    expect(transfers(tx)).toHaveLength(2);
  });
});

describe("planFeeSol", () => {
  it("sends the fixed amount iff the wallet is below the threshold and the faucet stays at its floor (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (walletLamports, faucetLamports, minLamports) => {
          const plan = planFeeSol(walletLamports, faucetLamports, minLamports);
          if (walletLamports >= FEE_SOL_THRESHOLD_LAMPORTS) {
            expect(plan).toEqual({ status: "not_needed" });
          } else if (faucetLamports - FEE_SOL_LAMPORTS >= minLamports) {
            expect(plan).toEqual({ status: "sent", lamports: FEE_SOL_LAMPORTS });
          } else {
            expect(plan).toEqual({ status: "faucet_low" });
          }
        },
      ),
    );
  });

  it("is exact at both edges", () => {
    expect(planFeeSol(FEE_SOL_THRESHOLD_LAMPORTS - 1n, 10n ** 10n, 0n).status).toBe("sent");
    expect(planFeeSol(FEE_SOL_THRESHOLD_LAMPORTS, 10n ** 10n, 0n).status).toBe("not_needed");
    expect(planFeeSol(0n, 100n + FEE_SOL_LAMPORTS, 100n).status).toBe("sent");
    expect(planFeeSol(0n, 99n + FEE_SOL_LAMPORTS, 100n).status).toBe("faucet_low");
  });
});

describe("createFaucet.claim fee SOL", () => {
  it("a fresh wallet gets the test-USDC and 0.01 SOL in the one claim transaction", async () => {
    const { faucet, chain, keypair } = setup();
    const w = Keypair.generate().publicKey;
    const before = chain.balance;
    expect(await faucet.claim(w.toBase58())).toMatchObject({
      status: 200,
      feeSol: { status: "sent", lamports: FEE_SOL_LAMPORTS },
    });
    expect(await chain.getBalance(w)).toBe(Number(FEE_SOL_LAMPORTS));
    expect(chain.mints).toHaveLength(1);
    expect(chain.sentTransactions).toHaveLength(1);
    const [tx] = chain.sentTransactions;
    const fee = transfers(tx ?? { instructions: [] }).find((t) => t.toPubkey.equals(w));
    expect(fee?.fromPubkey.equals(keypair.publicKey)).toBe(true);
    // The faucet paid the fee SOL plus the two marker rents.
    expect(before - chain.balance).toBe(Number(FEE_SOL_LAMPORTS) + 2 * chain.rent);
  });

  it("a wallet that already holds the threshold gets test-USDC and no SOL", async () => {
    const { faucet, chain } = setup();
    const w = Keypair.generate().publicKey;
    chain.accounts.set(w.toBase58(), { lamports: Number(FEE_SOL_THRESHOLD_LAMPORTS), dataLen: 0 });
    expect(await faucet.claim(w.toBase58())).toMatchObject({
      status: 200,
      feeSol: { status: "not_needed" },
    });
    expect(await chain.getBalance(w)).toBe(Number(FEE_SOL_THRESHOLD_LAMPORTS));
  });

  it("a repeat claim inside 24 h is refused and sends no more SOL", async () => {
    const { faucet, chain } = setup();
    const w = Keypair.generate().publicKey;
    expect((await faucet.claim(w.toBase58())).status).toBe(200);
    // Spend the fee SOL so the wallet is below the threshold again: still one claim per 24 h.
    chain.accounts.set(w.toBase58(), { lamports: 0, dataLen: 0 });
    expect(await faucet.claim(w.toBase58())).toEqual({
      status: 429,
      error: ALREADY_CLAIMED_MESSAGE,
    });
    expect(await chain.getBalance(w)).toBe(0);
    expect(chain.mints).toHaveLength(1);
  });

  it("too low on SOL to send fees: mints test-USDC, sends no SOL, logs and alerts once", async () => {
    const { faucet, chain, logs, alerts } = setup();
    chain.balance = 100 + Number(FEE_SOL_LAMPORTS) - 1; // the floor is 100 lamports
    const w = Keypair.generate().publicKey;
    expect(await faucet.claim(w.toBase58())).toMatchObject({
      status: 200,
      feeSol: { status: "faucet_low" },
    });
    expect(chain.mints).toHaveLength(1);
    expect(await chain.getBalance(w)).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({ event: "faucet_fee_sol_low" }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("fee SOL");
    await faucet.claim(wallet());
    expect(alerts).toHaveLength(1); // same cooldown as the out-of-funds alert
  });

  it("a claim that fails at the token account sends no SOL either (one transaction)", async () => {
    const { faucet, chain } = setup();
    chain.ataFailsWith = 5;
    const w = Keypair.generate().publicKey;
    const before = chain.balance;
    expect((await faucet.claim(w.toBase58())).status).toBe(502);
    expect(await chain.getBalance(w)).toBe(0);
    expect(chain.balance).toBe(before);
  });

  it("an unreadable claimant balance is a 502 before anything is sent", async () => {
    const { faucet, chain, keypair } = setup();
    const real = chain.getBalance.bind(chain);
    chain.getBalance = (address) =>
      address.equals(keypair.publicKey) ? real(address) : Promise.reject(new TypeError("rpc"));
    expect((await faucet.claim(wallet())).status).toBe(502);
    expect(chain.sentTransactions).toHaveLength(0);
  });
});
