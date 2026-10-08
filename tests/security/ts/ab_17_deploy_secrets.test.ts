// AB-17 for the devnet deploy script (M2-01): the deployment record holds public keys only, and
// the script reads key FILES by path, never the faucet's or the automation authority's secret.
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { readRepoFile, trackedFiles } from "./repo";

function isPublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/** Every string in `value` that sits in a key-ish position must parse as a public key. */
function problems(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    const bytes =
      value.length >= 32 && value.every((x) => Number.isInteger(x) && x >= 0 && x < 256);
    return bytes
      ? [`${path} is a raw byte array`]
      : value.flatMap((item, i) => problems(item, `${path}[${i}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => {
      const own = /secret|private|seed|mnemonic|keypair/i.test(key)
        ? [`${path}.${key} is secret-named`]
        : [];
      return [...own, ...problems(item, `${path}.${key}`)];
    });
  }
  return [];
}

describe("AB-17 deployment records hold public keys only", () => {
  const records = trackedFiles().filter((path) => /^deployments\/.*\.json$/.test(path));

  it("deployments/devnet.json is tracked", () => {
    expect(records).toContain("deployments/devnet.json");
  });

  it.each(records)("%s has no key bytes, no secret-named field and valid public keys", (path) => {
    const json: unknown = JSON.parse(readRepoFile(path));
    expect(problems(json, path)).toEqual([]);
    const programId = (json as { programId?: unknown }).programId;
    expect(typeof programId === "string" && isPublicKey(programId)).toBe(true);
  });

  it("detects key material in a record", () => {
    expect(problems({ admin: Array.from({ length: 64 }, () => 1) }, "r")).not.toEqual([]);
    expect(problems({ secretKey: "x" }, "r")).not.toEqual([]);
    expect(problems({ admin: "pubkey" }, "r")).toEqual([]);
  });
});

describe("AB-17 the deploy script never reads secret keys it does not need", () => {
  const sources = trackedFiles().filter(
    (path) => /^scripts\/(lib\/[^/]+|deploy-devnet)\.ts$/.test(path) && !path.endsWith(".test.ts"),
  );

  it("finds the script sources", () => {
    expect(sources).toContain("scripts/deploy-devnet.ts");
    expect(sources).toContain("scripts/lib/deploy.ts");
  });

  it("never mentions FAUCET_KEYPAIR or AUTOMATION_KEYPAIR in code (only public keys are taken)", () => {
    const offenders = sources.filter((path) =>
      /FAUCET_KEYPAIR|AUTOMATION_KEYPAIR/.test(
        readRepoFile(path).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("reads secret key bytes in one place only (lib/keypair.ts)", () => {
    const users = sources.filter((path) => /secretKey|fromSecretKey/.test(readRepoFile(path)));
    expect(users).toEqual(["scripts/lib/keypair.ts"]);
  });
});
