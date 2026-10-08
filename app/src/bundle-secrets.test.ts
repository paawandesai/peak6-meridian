// @vitest-environment node
/**
 * AC3 / NFR-16: no server-side environment variable name may appear in the client bundle.
 * Builds the app, then greps `.next/static` (everything shipped to the browser) for every
 * variable named in docs/environment.md and .env.example that is not `NEXT_PUBLIC_*`.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_DIR = join(APP_DIR, "..");

/** Names of all documented env vars that must stay server-side. */
function serverEnvNames(environmentMd: string, envExample: string): string[] {
  const names = new Set<string>();
  for (const line of environmentMd.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const match of firstCell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  for (const match of envExample.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names].filter((name) => !name.startsWith("NEXT_PUBLIC_")).sort();
}

/** Names that occur as a whole identifier (so `NEXT_PUBLIC_USDC_MINT` does not match `USDC_MINT`). */
function findLeakedNames(text: string, names: readonly string[]): string[] {
  return names.filter((name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("server env names in client code", () => {
  const names = serverEnvNames(
    readFileSync(join(REPO_DIR, "docs/environment.md"), "utf8"),
    readFileSync(join(REPO_DIR, ".env.example"), "utf8"),
  );

  it("collects the documented server variables and excludes NEXT_PUBLIC_*", () => {
    expect(names).toEqual(
      expect.arrayContaining([
        "FAUCET_KEYPAIR",
        "TIINGO_API_KEY",
        "USDC_MINT",
        "SERVICE_TOKEN",
        "QUANT_URL",
      ]),
    );
    expect(names.some((name) => name.startsWith("NEXT_PUBLIC_"))).toBe(false);
  });

  it("matches whole names only", () => {
    expect(findLeakedNames("process.env.USDC_MINT", ["USDC_MINT"])).toEqual(["USDC_MINT"]);
    expect(findLeakedNames("NEXT_PUBLIC_USDC_MINT", ["USDC_MINT"])).toEqual([]);
  });

  describe("build output", () => {
    beforeAll(() => {
      execFileSync("pnpm", ["exec", "next", "build"], {
        cwd: APP_DIR,
        stdio: "pipe",
        env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
      });
    }, 600_000);

    it("references no server env var names in .next/static", () => {
      const files = filesUnder(join(APP_DIR, ".next/static")).filter((f) =>
        /\.(js|css|html)$/.test(f),
      );
      expect(files.length).toBeGreaterThan(0);
      const leaks = files.flatMap((file) =>
        findLeakedNames(readFileSync(file, "utf8"), names).map((name) => `${name} in ${file}`),
      );
      expect(leaks).toEqual([]);
    });
  });
});
