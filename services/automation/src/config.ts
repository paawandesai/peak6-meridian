/**
 * Environment of the service (docs/environment.md). Validation errors name the variable and
 * never echo its value (keys, tokens and the webhook URL are secrets).
 */
import { Keypair } from "@solana/web3.js";
import { z } from "zod";

import type { Logger } from "./log";

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
});

export type ServiceEnv = z.infer<typeof envSchema>;

/** Validates `env`; throws naming the offending variables, never their values. */
export function parseEnv(env: Readonly<Record<string, string | undefined>>): ServiceEnv {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`invalid environment: ${names.join(", ")}`);
  }
  return result.data;
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
