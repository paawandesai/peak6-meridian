// AB-21 · Faucet abuse (threat-model.md; NFR-13; M2-09 AC3): one claim per wallet per 24 h,
// enforced atomically on chain by two day-bucket marker accounts created in the claim transaction.
// These tests drive the real claim logic against an in-memory cluster that interprets the real
// instructions (marker conflicts are the system program's "account already in use"); the
// local-validator half (real transactions, pre-funded markers) runs in `make e2e`.
import { Keypair, PublicKey } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { DEVNET_GENESIS_HASH, MAINNET_BETA_GENESIS_HASH } from "@meridian/client";

import { parseIntegerEnv } from "../../../app/src/lib/faucet/env";
import { FakeFaucetChain } from "../../../app/src/lib/faucet/fake-chain";
import {
  ALREADY_CLAIMED_MESSAGE,
  type ClaimResult,
  createFaucet,
  isMarkerConflict,
} from "../../../app/src/lib/faucet/faucet";
import { FEE_SOL_LAMPORTS, FEE_SOL_THRESHOLD_LAMPORTS } from "../../../app/src/lib/faucet/response";
import { dayBucket, markerSeed, SECONDS_PER_DAY } from "../../../app/src/lib/faucet/seed";

const DAY = SECONDS_PER_DAY;
const BLOCKHASH_LIFETIME_SECS = 90; // W: ~150 blocks, 60 to 90 s
const AMOUNT = 1_000_000_000n;
const FAKE_URL_KEY = "https://devnet.example/?api-key=SECRET123";

function setup(overrides: { skewMs?: number; cooldownMs?: number } = {}) {
  const keypair = Keypair.generate();
  const chain = new FakeFaucetChain();
  chain.mintAuthority = keypair.publicKey;
  // Start well inside a UTC day so tests choose the boundary explicitly.
  chain.unixTime = 20_000 * DAY + 3_600;
  const logs: Record<string, string | number>[] = [];
  const alerts: string[] = [];
  let localTime = 1_000_000 + (overrides.skewMs ?? 0);
  const make = (skewMs = 0) =>
    createFaucet({
      chain,
      keypair,
      mint: Keypair.generate().publicKey,
      amountBaseUnits: AMOUNT,
      minLamports: 100_000_000n,
      cluster: "devnet",
      rpcUrl: FAKE_URL_KEY,
      alert: (text) => {
        alerts.push(text);
        return Promise.resolve();
      },
      alertCooldownMs: overrides.cooldownMs ?? 3_600_000,
      now: () => localTime + skewMs,
      log: (entry) => logs.push(entry),
    });
  return {
    keypair,
    chain,
    logs,
    alerts,
    faucet: make(),
    make,
    setLocalTime: (ms: number) => (localTime = ms),
  };
}

/** A faucet on `chain` signing with `keypair` (the markers are derived from the faucet key). */
function faucetFor(chain: FakeFaucetChain, keypair: Keypair) {
  return createFaucet({
    chain,
    keypair,
    mint: Keypair.generate().publicKey,
    amountBaseUnits: AMOUNT,
    minLamports: 1n,
    cluster: "devnet",
    rpcUrl: "http://127.0.0.1:8899",
    alert: () => Promise.resolve(),
    alertCooldownMs: 1,
    now: () => 0,
    log: () => undefined,
  });
}

const wallet = () => Keypair.generate().publicKey.toBase58();
const status = (result: ClaimResult) => result.status;

describe("AB-21 marker seed", () => {
  it("pins the seed encoding with a known-answer vector", () => {
    // 32 raw pubkey bytes (all 7) followed by the bucket as a u64 little-endian; the expected value was
    // computed independently: sha256(bytes([7]*32) + (20000).to_bytes(8, 'little')).hexdigest()[:32].
    const key = new PublicKey(new Uint8Array(32).fill(7));
    expect(markerSeed(key, 20_000n)).toBe("26886d3772882b91f1d417d9e3447cc0");
    expect(markerSeed(key, 20_001n)).not.toBe(markerSeed(key, 20_000n));
    expect(markerSeed(key, 0n)).toHaveLength(32);
  });
});

describe("AB-21 one claim per wallet per 24 h", () => {
  it("mints once, then answers 429 and mints nothing more", async () => {
    const { faucet, chain } = setup();
    const w = wallet();
    const first = await faucet.claim(w);
    expect(first).toMatchObject({ status: 200, amountBaseUnits: AMOUNT });
    const second = await faucet.claim(w);
    expect(second).toEqual({ status: 429, error: ALREADY_CLAIMED_MESSAGE });
    expect(chain.mints).toHaveLength(1);
    expect(chain.mints[0]?.amount).toBe(AMOUNT);
  });

  it("does not let another wallet's claim block this one", async () => {
    const { faucet, chain } = setup();
    expect(status(await faucet.claim(wallet()))).toBe(200);
    expect(status(await faucet.claim(wallet()))).toBe(200);
    expect(chain.mints).toHaveLength(2);
  });

  it("treats whitespace around the same address as the same wallet", async () => {
    const { faucet, chain } = setup();
    const w = wallet();
    expect(status(await faucet.claim(w))).toBe(200);
    expect(status(await faucet.claim(`  ${w}  `))).toBe(429);
    expect(chain.mints).toHaveLength(1);
  });

  it("cannot be bypassed by respelling the address: a different spelling is a different, usually invalid, wallet", async () => {
    const { faucet } = setup();
    const w = wallet();
    expect(status(await faucet.claim(w))).toBe(200);
    for (const variant of [
      w.toLowerCase(),
      w.toUpperCase(),
      `${w}1`,
      w.slice(1),
      "",
      "not an address",
      "0".repeat(44),
    ]) {
      const result = await faucet.claim(variant);
      // Either rejected as invalid, or (if the respelling is itself a valid key) a distinct wallet.
      expect([200, 400]).toContain(result.status);
      if (result.status === 200) {
        expect(variant).not.toBe(w);
        expect(new PublicKey(variant).equals(new PublicKey(w))).toBe(false);
      }
    }
  });

  it("two concurrent claims for one wallet, including from separate instances, mint exactly once", async () => {
    const { chain, make } = setup();
    const w = wallet();
    const instances = [make(0), make(5_000), make(-5_000)];
    const results = await Promise.all(instances.map((f) => f.claim(w)));
    expect(results.map(status).sort()).toEqual([200, 429, 429]);
    expect(chain.mints).toHaveLength(1);
  });

  it("concurrent claims that both pass simulation still mint once (the confirmed-tx error path)", async () => {
    const { chain, make } = setup();
    const w = wallet();
    let sims = 0;
    // Hold every send until all three have simulated, so none sees a marker yet.
    chain.beforeSend = async () => {
      while (chain.simulations < 3) await new Promise((resolve) => setTimeout(resolve, 1));
      sims += 1;
    };
    const results = await Promise.all([make().claim(w), make().claim(w), make().claim(w)]);
    expect(sims).toBe(3);
    expect(results.map(status).sort()).toEqual([200, 429, 429]);
    expect(chain.mints).toHaveLength(1);
  });
});

describe("AB-21 midnight boundary and cluster time", () => {
  it("23:59 then 00:01 the next day is refused (the conflict is on bucket N+1 only)", async () => {
    const { faucet, chain } = setup();
    const w = wallet();
    chain.unixTime = 20_000 * DAY + (DAY - 60); // 23:59 of bucket N
    expect(status(await faucet.claim(w))).toBe(200);
    chain.unixTime = 20_001 * DAY + 60; // 00:01, bucket N+1
    expect(status(await faucet.claim(w))).toBe(429);
    expect(chain.mints).toHaveLength(1);
  });

  it("a conflict on bucket N alone is also refused", async () => {
    const { faucet, chain } = setup();
    const w = wallet();
    chain.unixTime = 20_000 * DAY + 100;
    expect(status(await faucet.claim(w))).toBe(200);
    chain.unixTime = 20_000 * DAY + 500;
    expect(status(await faucet.claim(w))).toBe(429);
  });

  it("day N then day N+2 is allowed", async () => {
    const { faucet, chain } = setup();
    const w = wallet();
    chain.unixTime = 20_000 * DAY + 100;
    expect(status(await faucet.claim(w))).toBe(200);
    chain.unixTime = 20_001 * DAY + 100;
    expect(status(await faucet.claim(w))).toBe(429);
    chain.unixTime = 20_002 * DAY;
    expect(status(await faucet.claim(w))).toBe(200);
    expect(chain.mints).toHaveLength(2);
  });

  it("instance wall clocks and their skew never move the buckets (cluster time is used)", async () => {
    const { chain, make, setLocalTime } = setup();
    const w = wallet();
    const behind = make(-2 * DAY * 1000);
    const ahead = make(2 * DAY * 1000);
    chain.unixTime = 20_000 * DAY + 100;
    expect(status(await behind.claim(w))).toBe(200);
    setLocalTime(9_999_999_999);
    // A wall clock two days ahead must not unlock the next bucket: the cluster is still on day N.
    expect(status(await ahead.claim(w))).toBe(429);
    chain.unixTime = 20_001 * DAY + 1;
    expect(status(await ahead.claim(w))).toBe(429);
  });

  it("the gap is at least 24 h minus W even when the claim lands W after it was built (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: DAY - 1 }),
        fc.integer({ min: 0, max: BLOCKHASH_LIFETIME_SECS }),
        async (offset, landingDelay) => {
          const { faucet, chain, keypair } = setup();
          const w = wallet();
          chain.unixTime = 20_000 * DAY + offset; // the bucket is read when the claim is built
          chain.beforeSend = () => {
            chain.unixTime += landingDelay; // ...and the transaction lands up to W later
            return Promise.resolve();
          };
          expect(status(await faucet.claim(w))).toBe(200);
          const landedAt = chain.unixTime;
          chain.beforeSend = undefined;
          // The allowed set only changes at bucket boundaries, so probe the start of each of the
          // next buckets (and the second before it) on a copy of the chain; a successful probe
          // must not consume the markers.
          let allowedAt: number | undefined;
          for (
            let k = Number(dayBucket(landedAt)) + 1;
            k <= Number(dayBucket(landedAt)) + 4;
            k += 1
          ) {
            const probe = chain.clone();
            probe.unixTime = k * DAY;
            if (status(await faucetFor(probe, keypair).claim(w)) === 200) {
              allowedAt = k * DAY;
              const before = chain.clone();
              before.unixTime = k * DAY - 1;
              expect(status(await faucetFor(before, keypair).claim(w))).toBe(429);
              break;
            }
          }
          expect(allowedAt).toBeDefined();
          expect((allowedAt ?? 0) - landedAt).toBeGreaterThanOrEqual(DAY - BLOCKHASH_LIFETIME_SECS);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("AB-21 failures that are not rate-limit hits", () => {
  it("a system-program failure at another instruction (ATA creation) is a 5xx and mints nothing", async () => {
    const { faucet, chain } = setup();
    chain.ataFailsWith = 0; // custom error 0 at a non-marker index must not read as "already claimed"
    const w = wallet();
    const result = await faucet.claim(w);
    expect(result.status).toBe(502);
    expect(chain.mints).toHaveLength(0);
    chain.ataFailsWith = undefined;
    expect(status(await faucet.claim(w))).toBe(200); // no marker was left behind by the failed claim
  });

  it("only custom error 0 at a marker index counts as a marker conflict", () => {
    const err = (index: number, code: number) => ({ InstructionError: [index, { Custom: code }] });
    expect(isMarkerConflict(err(1, 0), [1, 3])).toBe(true);
    expect(isMarkerConflict(err(3, 0), [1, 3])).toBe(true);
    expect(isMarkerConflict(err(4, 0), [1, 3])).toBe(false);
    expect(isMarkerConflict(err(1, 1), [1, 3])).toBe(false);
    expect(isMarkerConflict({ InstructionError: [1, "InvalidAccountData"] }, [1, 3])).toBe(false);
    expect(isMarkerConflict("BlockhashNotFound", [1, 3])).toBe(false);
    expect(isMarkerConflict(null, [1, 3])).toBe(false);
  });

  it("an expired transaction is not rebroadcast; the next attempt uses a fresh blockhash and cluster time", async () => {
    const { faucet, chain } = setup();
    const w = wallet();
    chain.expireNext = true;
    const expired = await faucet.claim(w);
    expect(expired.status).toBe(502);
    expect(chain.sentSignatures).toHaveLength(1); // sent once, never rebroadcast
    expect(chain.mints).toHaveLength(0);
    chain.unixTime += 300;
    const retry = await faucet.claim(w);
    expect(retry.status).toBe(200);
    expect(chain.blockhashes).toBe(2); // a new blockhash per attempt
  });
});

describe("AB-21 faucet funds", () => {
  it("below the floor: 503, no mint, one alert per cooldown, none of it containing keys or URLs", async () => {
    const { faucet, chain, alerts, logs, setLocalTime } = setup({ cooldownMs: 3_600_000 });
    chain.balance = 99_999_999;
    expect(status(await faucet.claim(wallet()))).toBe(503);
    expect(status(await faucet.claim(wallet()))).toBe(503);
    expect(alerts).toHaveLength(1);
    expect(chain.mints).toHaveLength(0);
    setLocalTime(1_000_000 + 3_600_000); // the cooldown has passed
    expect(status(await faucet.claim(wallet()))).toBe(503);
    expect(alerts).toHaveLength(2);
    const captured = JSON.stringify({ alerts, logs });
    expect(captured).not.toContain("SECRET123");
    expect(captured).not.toContain("https://");
  });

  it("at the floor exactly the faucet still serves", async () => {
    const { faucet, chain } = setup();
    chain.balance = 100_000_000;
    expect(status(await faucet.claim(wallet()))).toBe(200);
  });

  it("FAUCET_MIN_LAMPORTS is an integer: decimals, negatives and text are rejected (property)", () => {
    expect(parseIntegerEnv("FAUCET_MIN_LAMPORTS", undefined, 7n)).toBe(7n);
    expect(parseIntegerEnv("FAUCET_MIN_LAMPORTS", "  ", 7n)).toBe(7n);
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 17n }), (n) => {
        expect(parseIntegerEnv("X", n.toString(), 0n)).toBe(n);
      }),
    );
    for (const bad of [
      "0.1",
      "-5",
      "1e9",
      "0x10",
      "abc",
      "1 000",
      "+3",
      "1,000",
      "99999999999999999999",
    ]) {
      expect(() => parseIntegerEnv("FAUCET_MIN_LAMPORTS", bad, 0n)).toThrow();
    }
  });
});

describe("AB-21 mainnet and unreachable RPC", () => {
  it("refuses a mainnet genesis hash behind any hostname and mints nothing", async () => {
    const { faucet, chain, logs } = setup();
    chain.genesisHash = MAINNET_BETA_GENESIS_HASH;
    expect(status(await faucet.claim(wallet()))).toBe(503);
    expect(chain.mints).toHaveLength(0);
    expect(JSON.stringify(logs)).not.toContain("SECRET123");
  });

  it("allows a devnet genesis hash on a non-standard hostname", async () => {
    const { faucet, chain } = setup();
    chain.genesisHash = DEVNET_GENESIS_HASH;
    expect(status(await faucet.claim(wallet()))).toBe(200);
  });

  it("an unreachable RPC is refused and its error text (which echoes the URL) never reaches the client or the logs", async () => {
    const { faucet, chain, logs } = setup();
    chain.genesisError = new Error(`fetch failed: GET ${FAKE_URL_KEY}`);
    const result = await faucet.claim(wallet());
    expect(result.status).toBe(503);
    const captured = JSON.stringify({ result, logs });
    expect(captured).not.toContain("SECRET123");
    expect(captured).not.toContain("api-key");
    expect(chain.mints).toHaveLength(0);
  });
});

describe("AB-21 misconfiguration", () => {
  it("fails with a clear configuration error when the faucet key is not the mint authority", async () => {
    const { faucet, chain } = setup();
    chain.mintAuthority = Keypair.generate().publicKey;
    const result = await faucet.claim(wallet());
    expect(result.status).toBe(500);
    expect(result).toMatchObject({ error: expect.stringContaining("mint authority") });
    expect(chain.mints).toHaveLength(0);
  });

  it("dayBucket is the integer floor of unix seconds / 86400", () => {
    expect(dayBucket(0)).toBe(0n);
    expect(dayBucket(DAY - 1)).toBe(0n);
    expect(dayBucket(DAY)).toBe(1n);
    expect(() => dayBucket(-1)).toThrow();
    expect(() => dayBucket(1.5)).toThrow();
  });
});

describe("AB-21 fee SOL cannot be drained past the claim limits", () => {
  const FEE = Number(FEE_SOL_LAMPORTS);
  const lamportsOf = (chain: FakeFaucetChain, w: string) => chain.getBalance(new PublicKey(w));

  it("one wallet that spends its fee SOL every time still gets it once per 24 h claim", async () => {
    const { faucet, chain } = setup();
    const w = wallet();
    let received = 0;
    for (const day of [0, 0, 1, 1, 2, 2, 3]) {
      chain.unixTime = (20_000 + day) * DAY + 100;
      const result = await faucet.claim(w);
      received += await lamportsOf(chain, w);
      chain.accounts.set(w, { lamports: 0, dataLen: 0 }); // spend it all, as a drainer would
      expect([200, 429]).toContain(result.status);
    }
    // Claims succeed on days 0 and 2 only (day 1 and 3 hit bucket N+1); every repeat sends nothing.
    expect(chain.mints).toHaveLength(2);
    expect(received).toBe(2 * FEE);
  });

  it("concurrent claims for one wallet, from separate instances, send the fee SOL once", async () => {
    const { chain, make } = setup();
    const w = wallet();
    let sims = 0;
    chain.beforeSend = async () => {
      while (chain.simulations < 3) await new Promise((resolve) => setTimeout(resolve, 1));
      sims += 1;
    };
    const results = await Promise.all([
      make().claim(w),
      make(5_000).claim(w),
      make(-5_000).claim(w),
    ]);
    expect(sims).toBe(3);
    expect(results.map(status).sort()).toEqual([200, 429, 429]);
    expect(await lamportsOf(chain, w)).toBe(FEE);
  });

  it("any claim sequence: fee SOL only rides on successful claims, at most once per wallet per 24 h, and never takes the faucet below its floor (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            who: fc.integer({ min: 0, max: 3 }),
            dayStep: fc.integer({ min: 0, max: 2 }),
            spend: fc.boolean(),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        fc.integer({ min: 100_000_000, max: 100_000_000 + 6 * FEE }),
        async (steps, startBalance) => {
          const { faucet, chain } = setup();
          chain.balance = startBalance;
          const wallets = [wallet(), wallet(), wallet(), wallet()];
          const floor = 100_000_000;
          let day = 0;
          let sent = 0;
          let successes = 0;
          const lastSuccessDay = new Map<string, number>();
          for (const step of steps) {
            day += step.dayStep;
            chain.unixTime = (20_000 + day) * DAY + 100;
            const w = wallets[step.who] ?? wallets[0] ?? wallet();
            const before = await lamportsOf(chain, w);
            const faucetBefore = chain.balance;
            const result = await faucet.claim(w);
            const gained = (await lamportsOf(chain, w)) - before;
            if (result.status === 200) {
              successes += 1;
              const previous = lastSuccessDay.get(w);
              // The existing limit: never two successful claims within the same or next bucket.
              if (previous !== undefined) expect(day - previous).toBeGreaterThanOrEqual(2);
              lastSuccessDay.set(w, day);
              if (result.feeSol.status === "sent") {
                expect(gained).toBe(FEE);
                expect(before).toBeLessThan(Number(FEE_SOL_THRESHOLD_LAMPORTS));
                expect(faucetBefore - FEE).toBeGreaterThanOrEqual(floor);
                sent += FEE;
              } else {
                expect(gained).toBe(0);
              }
            } else {
              expect(gained).toBe(0); // refused or failed claims move no SOL to the claimant
            }
            if (step.spend) chain.accounts.set(w, { lamports: 0, dataLen: 0 });
          }
          expect(sent).toBeLessThanOrEqual(successes * FEE);
          // Fee SOL never pushed the faucet below its floor; only the marker rents (the existing
          // per-claim cost, paid even without fee SOL) can take it under, by at most one claim's.
          expect(chain.balance).toBeGreaterThanOrEqual(floor - 2 * chain.rent);
        },
      ),
      { numRuns: 40 },
    );
  });
});
