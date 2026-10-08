/**
 * M2-09 against the local validator: the real claim transactions (system transfer +
 * allocate-with-seed markers, ATA creation, mint-to) on a real cluster. Covers what the in-memory
 * cluster in `tests/security/ts/ab_21_faucet.test.ts` cannot: that the system program itself
 * rejects a second allocate with "account already in use", that a pre-funded marker address does
 * not block a claim, and that two truly concurrent claims mint exactly once.
 */
import { createMint, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  type Connection,
  Keypair,
  type PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import { connectionChain } from "../../../app/src/lib/faucet/chain";
import { createFaucet, type Faucet } from "../../../app/src/lib/faucet/faucet";
import { dayBucket, markerAddress, SECONDS_PER_DAY } from "../../../app/src/lib/faucet/seed";

const AMOUNT = 1_000_000_000n; // 1,000 test-USDC

type Step = <T>(name: string, run: (sigs: string[]) => Promise<T>) => Promise<T>;

export async function runFaucetChecks(options: {
  readonly connection: Connection;
  readonly admin: Keypair;
  readonly step: Step;
}): Promise<void> {
  const { connection, admin, step } = options;
  const faucetKey = Keypair.generate();
  const mint = await step(
    "faucet: fund the faucet key and create a test mint it controls",
    async (sigs) => {
      const fund = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: faucetKey.publicKey,
          lamports: 2_000_000_000,
        }),
      );
      sigs.push(await connection.sendTransaction(fund, [admin]));
      await connection.confirmTransaction(sigs[0] ?? "", "confirmed");
      return createMint(connection, admin, faucetKey.publicKey, null, 6);
    },
  );

  const realChain = connectionChain(connection);
  const makeFaucet = (clockOffsetSecs = 0): Faucet =>
    createFaucet({
      chain: {
        ...realChain,
        clusterUnixTime: async () => (await realChain.clusterUnixTime()) + clockOffsetSecs,
      },
      keypair: faucetKey,
      mint,
      amountBaseUnits: AMOUNT,
      minLamports: 1n,
      cluster: "localnet",
      rpcUrl: "http://127.0.0.1:8899",
      alert: () => Promise.resolve(),
      alertCooldownMs: 1,
      now: () => Date.now(),
      log: (entry) => console.log(`          faucet log ${JSON.stringify(entry)}`),
    });
  const balance = async (owner: PublicKey): Promise<bigint> => {
    try {
      return (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner))).amount;
    } catch {
      return 0n;
    }
  };
  const expectStatus = (actual: number, expected: number, what: string): void => {
    if (actual !== expected) throw new Error(`${what}: expected HTTP ${expected}, got ${actual}`);
  };

  const walletA = Keypair.generate().publicKey;
  await step(
    "faucet: first claim mints the fixed amount; a second claim is a 429 (system 'account already in use')",
    async (sigs) => {
      const first = await makeFaucet().claim(walletA.toBase58());
      expectStatus(first.status, 200, "first claim");
      if (first.status === 200) sigs.push(first.signature);
      if ((await balance(walletA)) !== AMOUNT)
        throw new Error("the first claim did not mint exactly the fixed amount");
      const second = await makeFaucet().claim(walletA.toBase58());
      expectStatus(second.status, 429, "second claim");
      if ((await balance(walletA)) !== AMOUNT) throw new Error("a refused claim must mint nothing");
    },
  );

  await step(
    "faucet: three truly concurrent claims for one wallet mint exactly once",
    async (sigs) => {
      const walletB = Keypair.generate().publicKey;
      const results = await Promise.all(
        [makeFaucet(), makeFaucet(), makeFaucet()].map((f) => f.claim(walletB.toBase58())),
      );
      // Identical transactions (same blockhash, same markers) are deduplicated by the cluster, so
      // several callers can legitimately see the same signature; a different transaction loses
      // with 429. Either way the wallet is minted for exactly once.
      const signatures = new Set<string>();
      for (const result of results) {
        if (result.status === 200) signatures.add(result.signature);
        else if (result.status !== 429) throw new Error(`unexpected HTTP ${result.status}`);
      }
      if (signatures.size !== 1) {
        throw new Error(`expected exactly one landed transaction, saw ${signatures.size}`);
      }
      sigs.push(...signatures);
      if ((await balance(walletB)) !== AMOUNT)
        throw new Error("concurrent claims must mint exactly once");
    },
  );

  await step("faucet: a pre-funded marker address does not block a claim", async (sigs) => {
    const walletC = Keypair.generate().publicKey;
    const bucket = dayBucket(await realChain.clusterUnixTime());
    const prefunded = await markerAddress(faucetKey.publicKey, walletC, bucket);
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: prefunded, lamports: 5_000 }),
    );
    sigs.push(await connection.sendTransaction(tx, [admin]));
    await connection.confirmTransaction(sigs[0] ?? "", "confirmed");
    const claim = await makeFaucet().claim(walletC.toBase58());
    expectStatus(claim.status, 200, "claim with a griefer-funded marker");
    if ((await balance(walletC)) !== AMOUNT) throw new Error("the pre-funded claim did not mint");
  });

  await step(
    "faucet: bucket N+1 is refused, bucket N+2 is allowed again (cluster clock moved)",
    async (sigs) => {
      expectStatus(
        (await makeFaucet(SECONDS_PER_DAY).claim(walletA.toBase58())).status,
        429,
        "claim on day N+1",
      );
      const later = await makeFaucet(2 * SECONDS_PER_DAY).claim(walletA.toBase58());
      expectStatus(later.status, 200, "claim on day N+2");
      if (later.status === 200) sigs.push(later.signature);
      if ((await balance(walletA)) !== 2n * AMOUNT)
        throw new Error("the day N+2 claim did not mint");
    },
  );
}
