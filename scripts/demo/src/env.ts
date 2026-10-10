/**
 * Environment and file I/O of the demo CLIs. Errors name variables, never their values (RPC
 * URLs can carry API keys; keys are secrets).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/** The repository root (scripts/demo/src → ../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_REGISTRY = "deployments/demo-sessions.json";
export const DEFAULT_CACHE = ".cache/demo-closes.json";

const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

const envSchema = z.object({
  MERIDIAN_DEVNET_RPC_URL: optional(z.url()),
  SOLANA_RPC_URL: optional(z.url()),
  MERIDIAN_PROGRAM_ID: optional(z.string().min(32)),
  AUTOMATION_KEYPAIR: optional(z.string()),
  ADMIN_KEYPAIR_PATH: optional(z.string()),
  TIINGO_API_KEY: optional(z.string()),
  TWELVEDATA_API_KEY: optional(z.string()),
});
export type DemoEnv = z.infer<typeof envSchema>;

/** Validates the environment; the error lists the offending variable names only. */
export function parseDemoEnv(env: Readonly<Record<string, string | undefined>>): DemoEnv {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`invalid environment: ${names.join(", ")}`);
  }
  return result.data;
}

/** MERIDIAN_DEVNET_RPC_URL wins over SOLANA_RPC_URL (as in the automation service). */
export function rpcUrlOf(env: DemoEnv): string | undefined {
  return env.MERIDIAN_DEVNET_RPC_URL ?? env.SOLANA_RPC_URL;
}

/** `~/x` → `$HOME/x`; relative paths resolve against the repo root (make runs from there). */
export function resolvePath(path: string, home: string = homedir()): string {
  const expanded = path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  return isAbsolute(expanded) ? expanded : resolve(REPO_ROOT, expanded);
}

/** The file's text, or null when it does not exist. */
export function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The value of a `--flag`, treating an empty string (an unset make variable) as absent. */
export function flag(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** `DRY_RUN=1`/`true`/`yes` → true; empty, `0`, `false`, `no` → false. */
export function isTruthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|y)$/i.test(value.trim());
}
