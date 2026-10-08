/** Faucet configuration from the server environment (docs/environment.md); never imported by client code. */
import { Keypair, PublicKey } from "@solana/web3.js";

export class FaucetConfigError extends Error {
  override readonly name = "FaucetConfigError";
}

export type FaucetEnv = {
  readonly FAUCET_KEYPAIR?: string | undefined;
  readonly FAUCET_AMOUNT_USDC?: string | undefined;
  readonly FAUCET_MIN_LAMPORTS?: string | undefined;
  readonly FAUCET_ALERT_COOLDOWN_SEC?: string | undefined;
  readonly ALERT_WEBHOOK_URL?: string | undefined;
  readonly USDC_MINT?: string | undefined;
  readonly SOLANA_CLUSTER?: string | undefined;
  readonly SOLANA_RPC_URL?: string | undefined;
};

export type FaucetSettings = {
  readonly keypair: Keypair;
  readonly mint: PublicKey;
  /** Test-USDC base units minted per claim. */
  readonly amountBaseUnits: bigint;
  readonly minLamports: bigint;
  readonly alertCooldownMs: number;
  readonly alertWebhookUrl: string | undefined;
  readonly cluster: string | undefined;
  readonly rpcUrl: string;
};

export const DEFAULT_AMOUNT_USDC = 1_000n;
export const DEFAULT_MIN_LAMPORTS = 100_000_000n;
export const DEFAULT_ALERT_COOLDOWN_SEC = 3_600;
const BASE_UNITS_PER_USDC = 1_000_000n;

/** A non-negative integer in plain decimal digits; anything else (decimals, signs, text) throws. */
export function parseIntegerEnv(name: string, value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value.trim() === "") return fallback;
  const text = value.trim();
  if (!/^\d{1,18}$/.test(text)) {
    throw new FaucetConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(text)}`);
  }
  return BigInt(text);
}

function parseKeypair(value: string | undefined): Keypair {
  if (value === undefined || value.trim() === "") {
    throw new FaucetConfigError("FAUCET_KEYPAIR is not set");
  }
  try {
    const bytes: unknown = JSON.parse(value);
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((b) => !Number.isInteger(b))) {
      throw new Error("not a 64-byte array");
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  } catch {
    // Never echo the value: it is key material.
    throw new FaucetConfigError("FAUCET_KEYPAIR must be a JSON array of 64 bytes");
  }
}

function parseMint(value: string | undefined): PublicKey {
  if (value === undefined || value.trim() === "") throw new FaucetConfigError("USDC_MINT is not set");
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new FaucetConfigError("USDC_MINT is not a base58 public key");
  }
}

/** Validates the environment; throws `FaucetConfigError` naming the variable (never its value). */
export function parseFaucetEnv(env: FaucetEnv): FaucetSettings {
  const amountUsdc = parseIntegerEnv("FAUCET_AMOUNT_USDC", env.FAUCET_AMOUNT_USDC, DEFAULT_AMOUNT_USDC);
  if (amountUsdc === 0n) throw new FaucetConfigError("FAUCET_AMOUNT_USDC must be at least 1");
  const cooldownSec = parseIntegerEnv(
    "FAUCET_ALERT_COOLDOWN_SEC",
    env.FAUCET_ALERT_COOLDOWN_SEC,
    BigInt(DEFAULT_ALERT_COOLDOWN_SEC),
  );
  const rpcUrl = env.SOLANA_RPC_URL?.trim();
  if (rpcUrl === undefined || rpcUrl === "") throw new FaucetConfigError("SOLANA_RPC_URL is not set");
  const webhook = env.ALERT_WEBHOOK_URL?.trim();
  return {
    keypair: parseKeypair(env.FAUCET_KEYPAIR),
    mint: parseMint(env.USDC_MINT),
    amountBaseUnits: amountUsdc * BASE_UNITS_PER_USDC,
    minLamports: parseIntegerEnv("FAUCET_MIN_LAMPORTS", env.FAUCET_MIN_LAMPORTS, DEFAULT_MIN_LAMPORTS),
    alertCooldownMs: Number(cooldownSec) * 1000,
    alertWebhookUrl: webhook === undefined || webhook === "" ? undefined : webhook,
    cluster: env.SOLANA_CLUSTER?.trim() || undefined,
    rpcUrl,
  };
}
