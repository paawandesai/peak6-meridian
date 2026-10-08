/**
 * Shared pieces of the Vercel and Railway deploy commands (M2-11): secret redaction, a JSON HTTP
 * helper with a timeout, and the per-target environment specs. Tokens and variable VALUES never
 * reach a log line or an error message; only variable NAMES do.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type PlatformDeps = {
  readonly fetch: FetchLike;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
};

const MIN_SECRET_LENGTH = 6;

/** Replaces every occurrence of each secret value (long enough to be a secret) with `***`. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .reduce((acc, secret) => acc.split(secret).join("***"), text);
}

/** JSON request with a 30 s timeout. Errors carry the method, path and status, never the token. */
export async function requestJson(
  deps: Pick<PlatformDeps, "fetch">,
  label: string,
  url: string,
  init: RequestInit,
  secrets: readonly string[],
): Promise<{ readonly status: number; readonly body: unknown }> {
  let response: Response;
  try {
    response = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(`${label}: request failed (${reason})`, secrets));
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export type EnvSpec = {
  readonly required: readonly string[];
  readonly optional: readonly string[];
};

/** Variables the app needs on Vercel; `NEXT_PUBLIC_*` are public, the rest are server-only. */
export const APP_ENV: EnvSpec = {
  required: [
    "NEXT_PUBLIC_CLUSTER",
    "NEXT_PUBLIC_RPC_URL",
    "NEXT_PUBLIC_PROGRAM_ID",
    "NEXT_PUBLIC_USDC_MINT",
    "SOLANA_CLUSTER",
    "SOLANA_RPC_URL",
    "USDC_MINT",
    "FAUCET_KEYPAIR",
  ],
  optional: [
    "FINNHUB_API_KEY",
    "TIINGO_API_KEY",
    "ALERT_WEBHOOK_URL",
    "FAUCET_AMOUNT_USDC",
    "FAUCET_MIN_LAMPORTS",
    "FAUCET_ALERT_COOLDOWN_SEC",
  ],
};

/** Variables the automation service needs on Railway (services/automation/src/config.ts). */
export const AUTOMATION_ENV: EnvSpec = {
  required: [
    "SOLANA_CLUSTER",
    "SOLANA_RPC_URL",
    "MERIDIAN_PROGRAM_ID",
    "AUTOMATION_KEYPAIR",
    "SERVICE_TOKEN",
    "TIINGO_API_KEY",
    "TWELVEDATA_API_KEY",
    "SWITCHBOARD_QUEUE",
    "SWITCHBOARD_FEEDS_JSON",
  ],
  optional: ["ALERT_WEBHOOK_URL", "OPS_AGENT_URL"],
};

export type CollectedEnv = {
  readonly values: Readonly<Record<string, string>>;
  readonly missingRequired: readonly string[];
  readonly missingOptional: readonly string[];
};

/** Picks the spec's variables from `env`; an unset or blank value counts as missing. */
export function collectEnv(
  spec: EnvSpec,
  env: Readonly<Record<string, string | undefined>>,
): CollectedEnv {
  const values: Record<string, string> = {};
  const present = (name: string): boolean => {
    const value = env[name];
    if (value === undefined || value.trim() === "") return false;
    values[name] = value;
    return true;
  };
  return {
    values,
    missingRequired: spec.required.filter((name) => !present(name)),
    missingOptional: spec.optional.filter((name) => !present(name)),
  };
}

/** Throws (names only) when required variables are missing. */
export function assertComplete(target: string, collected: CollectedEnv): void {
  if (collected.missingRequired.length > 0) {
    throw new Error(
      `${target}: missing required variables: ${collected.missingRequired.join(", ")}`,
    );
  }
}

export function isPublicName(name: string): boolean {
  return name.startsWith("NEXT_PUBLIC_");
}

/** Every secret-ish value in play, for redaction (tokens plus all collected variable values). */
export function secretValues(tokens: readonly string[], collected: CollectedEnv): string[] {
  return [...tokens, ...Object.values(collected.values)];
}
