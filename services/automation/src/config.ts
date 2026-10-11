/**
 * Environment of the service (docs/environment.md). Validation errors name the variable and
 * never echo its value (keys, tokens and the webhook URL are secrets).
 */
import { Keypair } from "@solana/web3.js";
import { z } from "zod";

import type { Logger } from "./log";
import { PYTH_LAZER_URL } from "./pythLazer";
import { DEFAULT_MAX_API_CALLS_PER_RUN } from "./settlePacing";

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const envSchema = z.object({
  SOLANA_CLUSTER: z.preprocess(emptyToUndefined, z.string().default("localnet")),
  SOLANA_RPC_URL: z.url(),
  MERIDIAN_PROGRAM_ID: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  // Optional here: a missing key is a degraded service (M2-03 AC5b), not a crash.
  AUTOMATION_KEYPAIR: z.preprocess(emptyToUndefined, z.string().optional()),
  SERVICE_TOKEN: z.string().min(8),
  TIINGO_API_KEY: z.string().min(1),
  TWELVEDATA_API_KEY: z.string().min(1),
  ALERT_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  OPS_AGENT_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  // Local validator only: the Config admin that signs the test-only local oracle.
  ADMIN_KEYPAIR_PATH: z.preprocess(emptyToUndefined, z.string().optional()),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(65_535).default(4000)),
  // Demo mode: short-close markets for quick lifecycle demonstration (devnet only).
  DEMO_MODE: z.preprocess(emptyToUndefined, z.enum(["replay", "live"]).default("live")),
  DEMO_CLOSE_IN_SECS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(300).max(14_400).default(3600),
  ),
  // Data-API requests one settlement run (one per minute) may cause (#53). The default of 8 fits
  // Twelve Data's free tier (8/min); the minimum of 4 is one devnet attempt (2 checks + 2 oracle).
  SETTLE_MAX_API_CALLS_PER_RUN: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(4).max(100).default(DEFAULT_MAX_API_CALLS_PER_RUN),
  ),
});

export type ServiceEnv = z.infer<typeof envSchema>;

/** Validates `env`; throws naming the offending variables, never their values. */
export function parseEnv(env: Readonly<Record<string, string | undefined>>): ServiceEnv {
  // MERIDIAN_DEVNET_RPC_URL (dedicated devnet RPC, e.g. Helius) wins over SOLANA_RPC_URL.
  const preferred = env.MERIDIAN_DEVNET_RPC_URL?.trim();
  const result = envSchema.safeParse(preferred ? { ...env, SOLANA_RPC_URL: preferred } : env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`invalid environment: ${names.join(", ")}`);
  }
  return result.data;
}

const pythEnvSchema = z.object({
  // Pyth settlement (D-055): off unless exactly "true". The default path is unchanged.
  PYTH_SETTLEMENT_ENABLED: z.preprocess(
    emptyToUndefined,
    z.enum(["true", "false"]).default("false"),
  ),
  PYTH_API_TOKEN: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  PYTH_LAZER_URL: z.preprocess(emptyToUndefined, z.url().default(PYTH_LAZER_URL)),
});

export interface PythSettlementEnv {
  readonly apiToken: string;
  readonly baseUrl: string;
}

/**
 * The Pyth settlement switch: null when off (the default). When on, `PYTH_API_TOKEN` is
 * required; errors name the variable, never its value.
 */
export function parsePythSettlementEnv(
  env: Readonly<Record<string, string | undefined>>,
): PythSettlementEnv | null {
  const result = pythEnvSchema.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`invalid environment: ${names.join(", ")}`);
  }
  if (result.data.PYTH_SETTLEMENT_ENABLED === "false") {
    return null;
  }
  if (result.data.PYTH_API_TOKEN === undefined) {
    throw new Error("invalid environment: PYTH_API_TOKEN (required by PYTH_SETTLEMENT_ENABLED)");
  }
  return { apiToken: result.data.PYTH_API_TOKEN, baseUrl: result.data.PYTH_LAZER_URL };
}

/** The keypair from `AUTOMATION_KEYPAIR` (a JSON array of 64 bytes); the error never shows it. */
export function parseKeypair(text: string): Keypair {
  let bytes: number[] | undefined;
  try {
    const parsed = z.array(z.number().int().min(0).max(255)).length(64).safeParse(JSON.parse(text));
    bytes = parsed.success ? parsed.data : undefined;
  } catch {
    bytes = undefined;
  }
  if (bytes === undefined) {
    throw new Error("AUTOMATION_KEYPAIR must be a JSON array of 64 bytes");
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new Error("AUTOMATION_KEYPAIR is not a valid ed25519 keypair");
  }
}

/**
 * Loads `AUTOMATION_KEYPAIR` for the service. A missing or unparseable value does not crash the
 * service (M2-03 AC5b): it returns null with a reason that contains no key material, and the
 * service starts degraded. The raw text is never logged.
 */
export function loadAutomationKey(
  text: string | undefined,
  log: Logger,
): { readonly keypair: Keypair | null; readonly problem: string | null } {
  if (text === undefined || text.trim() === "") {
    log("error", "automation_key_missing", {});
    return { keypair: null, problem: "AUTOMATION_KEYPAIR is not set" };
  }
  try {
    return { keypair: parseKeypair(text), problem: null };
  } catch (error) {
    // parseKeypair's messages never include the value.
    const problem = error instanceof Error ? error.message : "AUTOMATION_KEYPAIR is invalid";
    log("error", "automation_key_invalid", { problem });
    return { keypair: null, problem };
  }
}
