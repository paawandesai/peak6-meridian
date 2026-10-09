/**
 * The faucet claim (M2-09): mints a fixed amount of test-USDC, at most once per wallet per
 * 24 h, enforced on chain by two day-bucket marker accounts created in the same transaction as the
 * mint (see `seed.ts`). Cluster time, never an instance wall clock, picks the buckets. This module
 * takes its configuration and a `FaucetChain` as parameters, reads no environment, and never puts
 * a key, the RPC URL or the webhook URL into a result, an error or a log entry.
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  type Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { assertCluster, ClusterError, redactRpcUrl } from "@meridian/client";

import type { FaucetChain } from "./chain";
import { dayBucket, markerSeed } from "./seed";

/** System-program error code for "account already in use" (`SystemError::AccountAlreadyInUse`). */
const ACCOUNT_ALREADY_IN_USE = 0;
const MARKER_SPACE = 1;

export type LogFn = (entry: Record<string, string | number>) => void;

export type FaucetDeps = {
  readonly chain: FaucetChain;
  readonly keypair: Keypair;
  readonly mint: PublicKey;
  readonly amountBaseUnits: bigint;
  readonly minLamports: bigint;
  readonly cluster: string | undefined;
  readonly rpcUrl: string;
  /** Sends the low-balance alert; the caller owns the webhook URL. */
  readonly alert: (text: string) => Promise<void>;
  readonly alertCooldownMs: number;
  /** Monotonic-enough milliseconds, used only for the alert cooldown. */
  readonly now: () => number;
  readonly log: LogFn;
};

export type ClaimResult =
  | { readonly status: 200; readonly signature: string; readonly amountBaseUnits: bigint }
  | { readonly status: 400; readonly error: string }
  | { readonly status: 429; readonly error: string }
  | { readonly status: 500; readonly error: string }
  | { readonly status: 502; readonly error: string }
  | { readonly status: 503; readonly error: string };

export const ALREADY_CLAIMED_MESSAGE =
  "This wallet already claimed test-USDC. The faucet allows one claim per wallet per 24 hours " +
  "(at least 24 hours minus about 90 seconds, and up to about 48 hours in practice).";

type InstructionError = { InstructionError: [number, unknown] };

function instructionError(err: unknown): InstructionError["InstructionError"] | null {
  if (typeof err !== "object" || err === null || !("InstructionError" in err)) return null;
  const value = (err as InstructionError).InstructionError;
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" ? value : null;
}

/**
 * True only for "account already in use" (system custom error 0) raised by one of the marker
 * `allocateWithSeed` instructions; any other failure, including the same code at another
 * instruction (for example ATA creation), is not a rate-limit hit.
 */
export function isMarkerConflict(err: unknown, markerIndexes: readonly number[]): boolean {
  const found = instructionError(err);
  if (found === null || !markerIndexes.includes(found[0])) return false;
  const detail = found[1];
  return (
    typeof detail === "object" &&
    detail !== null &&
    "Custom" in detail &&
    (detail as { Custom: unknown }).Custom === ACCOUNT_ALREADY_IN_USE
  );
}

type Built = {
  readonly tx: Transaction;
  readonly markerIndexes: readonly number[];
};

async function buildClaim(
  deps: FaucetDeps,
  wallet: PublicKey,
  bucket: bigint,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): Promise<Built> {
  const payer = deps.keypair.publicKey;
  const rent = await deps.chain.getMinimumBalanceForRentExemption(MARKER_SPACE);
  const instructions: TransactionInstruction[] = [];
  const markerIndexes: number[] = [];
  for (const marked of [bucket, bucket + 1n]) {
    const seed = markerSeed(wallet, marked);
    const marker = await PublicKey.createWithSeed(payer, seed, SystemProgram.programId);
    instructions.push(
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: marker, lamports: rent }),
    );
    markerIndexes.push(instructions.length);
    instructions.push(
      SystemProgram.allocate({
        accountPubkey: marker,
        basePubkey: payer,
        seed,
        space: MARKER_SPACE,
        programId: SystemProgram.programId,
      }),
    );
  }
  // Transfer SOL for transaction fees (0.01 SOL = 10M lamports)
  instructions.push(
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: wallet, lamports: 10_000_000n }),
  );
  const ata = getAssociatedTokenAddressSync(deps.mint, wallet);
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, wallet, deps.mint),
  );
  instructions.push(createMintToInstruction(deps.mint, ata, payer, deps.amountBaseUnits));
  const tx = new Transaction({ feePayer: payer, ...blockhash }).add(...instructions);
  tx.sign(deps.keypair);
  return { tx, markerIndexes };
}

export type Faucet = {
  claim(walletInput: string): Promise<ClaimResult>;
};

export function createFaucet(deps: FaucetDeps): Faucet {
  let verifiedConfig = false;
  let lastAlertAt: number | undefined;

  async function maybeAlert(balance: number): Promise<void> {
    const now = deps.now();
    if (lastAlertAt !== undefined && now - lastAlertAt < deps.alertCooldownMs) return;
    lastAlertAt = now;
    try {
      await deps.alert(
        `Meridian faucet balance is below its floor (${balance} lamports < ${deps.minLamports}). ` +
          "Claims return 503 until the faucet key is topped up.",
      );
    } catch (error) {
      deps.log({ event: "faucet_alert_failed", reason: (error as Error).name });
    }
  }

  async function checkConfig(): Promise<ClaimResult | null> {
    if (verifiedConfig) return null;
    let authority: PublicKey | null;
    try {
      authority = await deps.chain.getMintAuthority(deps.mint);
    } catch (error) {
      deps.log({ event: "faucet_mint_unreadable", reason: (error as Error).name });
      return {
        status: 502,
        error: "The faucet could not read the test-USDC mint; try again shortly.",
      };
    }
    if (authority === null || !authority.equals(deps.keypair.publicKey)) {
      deps.log({ event: "faucet_misconfigured", reason: "faucet key is not the mint authority" });
      return {
        status: 500,
        error:
          "The faucet is misconfigured: its key is not the mint authority of the test-USDC mint.",
      };
    }
    verifiedConfig = true;
    return null;
  }

  async function attempt(wallet: PublicKey): Promise<ClaimResult> {
    // A fresh blockhash and fresh cluster time on every attempt; a signed transaction is never reused.
    const blockhash = await deps.chain.getLatestBlockhash();
    const bucket = dayBucket(await deps.chain.clusterUnixTime());
    const { tx, markerIndexes } = await buildClaim(deps, wallet, bucket, blockhash);

    const simulation = await deps.chain.simulate(tx);
    if (simulation.err !== null && simulation.err !== undefined) {
      if (isMarkerConflict(simulation.err, markerIndexes)) {
        return { status: 429, error: ALREADY_CLAIMED_MESSAGE };
      }
      deps.log({ event: "faucet_simulation_failed", reason: "unexpected transaction error" });
      return { status: 502, error: "The faucet could not complete the claim; try again shortly." };
    }

    const signature = await deps.chain.send(tx);
    const confirmed = await deps.chain.confirm(signature, blockhash);
    if (confirmed.expired) {
      // Not rebroadcast: the blockhash expired, so this attempt can no longer land.
      deps.log({ event: "faucet_claim_expired" });
      return { status: 502, error: "The claim did not confirm in time; try again." };
    }
    if (confirmed.err !== null && confirmed.err !== undefined) {
      if (isMarkerConflict(confirmed.err, markerIndexes)) {
        return { status: 429, error: ALREADY_CLAIMED_MESSAGE };
      }
      deps.log({ event: "faucet_claim_failed", reason: "unexpected transaction error" });
      return { status: 502, error: "The faucet could not complete the claim; try again shortly." };
    }
    return { status: 200, signature, amountBaseUnits: deps.amountBaseUnits };
  }

  return {
    async claim(walletInput) {
      let wallet: PublicKey;
      try {
        // Parsed to the 32 raw bytes: base58 is bijective, so only the canonical bytes (never the
        // text) feed the marker seed and no spelling of an address can create a second marker.
        wallet = new PublicKey(walletInput.trim());
        // A program-derived (off-curve) address cannot own an associated token account.
        if (!PublicKey.isOnCurve(wallet.toBytes())) throw new Error("off curve");
      } catch {
        return { status: 400, error: "That is not a valid wallet address." };
      }
      try {
        await assertCluster({
          cluster: deps.cluster,
          rpcUrl: deps.rpcUrl,
          getGenesisHash: () => deps.chain.getGenesisHash(),
        });
      } catch (error) {
        const reason = error instanceof ClusterError ? error.message : "cluster check failed";
        deps.log({ event: "faucet_cluster_refused", reason: redactRpcUrl(reason, deps.rpcUrl) });
        return {
          status: 503,
          error: "The faucet only runs on Solana devnet or a local validator.",
        };
      }
      try {
        const misconfigured = await checkConfig();
        if (misconfigured !== null) return misconfigured;

        const balance = await deps.chain.getBalance(deps.keypair.publicKey);
        if (BigInt(balance) < deps.minLamports) {
          await maybeAlert(balance);
          return {
            status: 503,
            error: "The faucet is out of funds right now; please try again later.",
          };
        }
        return await attempt(wallet);
      } catch (error) {
        // Only the error class: messages from the RPC client can echo the URL.
        deps.log({ event: "faucet_error", reason: (error as Error).name });
        return {
          status: 502,
          error: "The faucet could not complete the claim; try again shortly.",
        };
      }
    },
  };
}
