// AB-17 (M1-09): Switchboard feed definitions are public (their hash is pinned on-chain and the
// jobs are published to Crossbar), so they must never carry an API key. Keys reach the oracles
// only as request-time `variableOverrides` filling a `${NAME}` placeholder in the Authorization
// header. The dry-run fixtures are committed too and get the same scan.
import { describe, expect, it } from "vitest";

import { readRepoFile, trackedFiles } from "./repo";

const FEEDS_DIR = "oracle/feeds/";
const FIXTURES_DIR = "scripts/switchboard/fixtures/";
const KEY_VARIABLES = ["TIINGO_API_KEY", "TWELVEDATA_API_KEY"];
/** Query parameters the data APIs accept a key in. */
const KEY_PARAMS = /[?&](token|apikey|api_key|apiKey|key)=/i;
/** Long hex or base64-ish runs: Tiingo keys are 40 hex chars, Twelve Data keys 32. */
const KEY_SHAPED =
  /\b[0-9a-f]{24,}\b|\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{32,}\b/;
/** Fixture oracle identities are Solana public keys (base58), which are public by definition. */
const PUBLIC_KEY_PATH = /^\$\.oracles\[\d+\]$/;
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PLACEHOLDER_AUTH = /^(Token|apikey) \$\{(TIINGO_API_KEY|TWELVEDATA_API_KEY)\}$/;

/** Every string in a JSON value, with its JSON path. */
function strings(value: unknown, path = "$"): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [
      [`${path}.${k}#key`, k] as [string, string],
      ...strings(v, `${path}.${k}`),
    ]);
  }
  return [];
}

/** Why a string in a feed definition looks like a literal credential, or null. */
function literalKeyReason(path: string, text: string): string | null {
  if (PUBLIC_KEY_PATH.test(path) && BASE58_PUBKEY.test(text)) return null;
  if (KEY_PARAMS.test(text)) return "key query parameter";
  if (KEY_SHAPED.test(text.replace(/\$\{[A-Z0-9_]+\}/g, ""))) return "key-shaped literal";
  if (path.endsWith(".value") && /^(Token|apikey|Bearer)\b/i.test(text)) {
    return PLACEHOLDER_AUTH.test(text) ? null : "Authorization header without a placeholder";
  }
  return null;
}

function definitionOffenders(files: readonly string[]): string[] {
  return files.flatMap((file) =>
    strings(JSON.parse(readRepoFile(file)))
      .map(([path, text]) => [path, literalKeyReason(path, text)] as const)
      .filter(([, reason]) => reason !== null)
      .map(([path, reason]) => `${file} ${path}: ${reason ?? ""}`),
  );
}

/** Real keys in the environment (the .env.example `test-…` placeholders don't count). */
function environmentKeys(): string[] {
  return KEY_VARIABLES.map((name) => process.env[name]?.trim() ?? "").filter(
    (value) => value.length >= 8 && !value.startsWith("test-"),
  );
}

const feedFiles = trackedFiles().filter((p) => p.startsWith(FEEDS_DIR) && p.endsWith(".json"));
const fixtureFiles = trackedFiles().filter((p) => p.startsWith(FIXTURES_DIR));

describe("AB-17 feed definitions carry no secrets", () => {
  it("all 14 definitions are tracked (7 tickers × Tiingo, Twelve Data)", () => {
    expect(feedFiles).toHaveLength(14);
  });

  it("no definition contains a literal API key", () => {
    expect(definitionOffenders(feedFiles)).toEqual([]);
  });

  it("every definition takes its key only as a placeholder in the Authorization header", () => {
    for (const file of feedFiles) {
      const all = strings(JSON.parse(readRepoFile(file)));
      const withPlaceholder = all.filter(([, text]) => text.includes("${"));
      expect(
        withPlaceholder.map(([path]) => path),
        file,
      ).toEqual(["$.jobs[0].tasks[0].httpTask.headers[0].value"]);
      expect(withPlaceholder[0]?.[1], file).toMatch(PLACEHOLDER_AUTH);
    }
  });

  it("no definition or fixture contains a key-shaped literal", () => {
    expect(definitionOffenders(fixtureFiles.filter((p) => p.endsWith(".json")))).toEqual([]);
  });

  it("no tracked file contains the real API keys from the environment", () => {
    const keys = environmentKeys();
    const offenders = trackedFiles()
      .filter((path) => !/\.(png|jpg|ico|woff2?)$/.test(path))
      .filter((path) => {
        const content = readRepoFile(path);
        return keys.some((key) => content.includes(key));
      });
    // Only paths are reported, never the key values.
    expect(offenders).toEqual([]);
  });

  it("the detector catches literal keys in every place a definition could hold one", () => {
    const hex40 = Array.from({ length: 40 }, (_, i) => "0123456789abcdef"[(i * 7) % 16]).join("");
    const mixed32 = Array.from({ length: 32 }, (_, i) => "aB3dE5gH7jK9mN1p"[i % 16]).join("");
    expect(literalKeyReason("$.url", `https://api.tiingo.com/x?token=${"${T}"}`)).toBe(
      "key query parameter",
    );
    expect(literalKeyReason("$.headers[0].value", `Token ${hex40}`)).toBe("key-shaped literal");
    expect(literalKeyReason("$.headers[0].value", `apikey ${mixed32}`)).toBe("key-shaped literal");
    expect(literalKeyReason("$.headers[0].value", "apikey short")).toBe(
      "Authorization header without a placeholder",
    );
    expect(literalKeyReason("$.headers[0].value", "Token ${TIINGO_API_KEY}")).toBeNull();
    expect(literalKeyReason("$.name", "AAPL close Tiingo")).toBeNull();
    expect(
      literalKeyReason("$.oracles[0]", "9v5s7i4uVXr5PP6P4EhJ3mKZxFR5r5je3QG69pSMUyNH"),
    ).toBeNull();
    expect(literalKeyReason("$.responses.x", mixed32)).toBe("key-shaped literal");
  });
});
