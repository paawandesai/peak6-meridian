// AB-17: secrets must never be committed. `.env` files and keypairs are gitignored, nothing of
// the kind is tracked, and `.env.example` carries placeholders only.
import { describe, expect, it } from "vitest";

import { isGitIgnored, readRepoFile, trackedFiles } from "./repo";

/** A Solana keypair file is a JSON array of 64 byte values. */
function looksLikeKeypair(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  return (
    Array.isArray(parsed) &&
    parsed.length === 64 &&
    parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}

describe("AB-17 no committed secrets", () => {
  it.each([".env", "services/quant/.env", "prod.env", "keys/admin.json", "test-ledger/x"])(
    "%s is gitignored",
    (path) => {
      expect(isGitIgnored(path)).toBe(true);
    },
  );

  it(".env.example stays committable", () => {
    expect(isGitIgnored(".env.example")).toBe(false);
  });

  it("no .env file or keys/ entry is tracked", () => {
    const offenders = trackedFiles().filter(
      (path) =>
        (/(^|\/)[^/]*\.env$/.test(path) || /(^|\/)keys\//.test(path)) && path !== ".env.example",
    );
    expect(offenders).toEqual([]);
  });

  it("no tracked JSON file is a Solana keypair", () => {
    const offenders = trackedFiles()
      .filter((path) => path.endsWith(".json"))
      .filter((path) => looksLikeKeypair(readRepoFile(path)));
    expect(offenders).toEqual([]);
  });

  it("recognises a keypair-shaped file", () => {
    expect(looksLikeKeypair(JSON.stringify(Array.from({ length: 64 }, (_, i) => i)))).toBe(true);
    expect(looksLikeKeypair(JSON.stringify({ name: "meridian" }))).toBe(false);
    expect(looksLikeKeypair("not json")).toBe(false);
  });

  it(".env.example leaves every secret key variable empty", () => {
    const secrets = ["AUTOMATION_KEYPAIR", "MARKET_MAKER_KEYPAIR", "FAUCET_KEYPAIR"];
    const lines = readRepoFile(".env.example").split("\n");
    for (const name of secrets) {
      expect(lines).toContain(`${name}=`);
    }
  });
});
