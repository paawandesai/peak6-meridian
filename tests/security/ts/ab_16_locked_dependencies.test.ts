// AB-16: a compromised dependency must not slip in through an unpinned install.
// Lockfiles are committed and every install path refuses to deviate from them.
import { describe, expect, it } from "vitest";

import { readRepoFile, trackedFiles } from "./repo";

describe("AB-16 locked dependencies", () => {
  it.each(["Cargo.lock", "pnpm-lock.yaml", "uv.lock"])("%s is committed", (lockfile) => {
    expect(trackedFiles()).toContain(lockfile);
  });

  it("make install refuses to change any lockfile", () => {
    const makefile = readRepoFile("Makefile");
    expect(makefile).toMatch(/pnpm install --frozen-lockfile/);
    expect(makefile).toMatch(/uv sync --locked/);
    expect(makefile).toMatch(/cargo fetch --locked/);
  });

  it("CI audits the dependencies of all three ecosystems", () => {
    const makefile = readRepoFile("Makefile");
    expect(makefile).toMatch(/pnpm audit --audit-level high/);
    expect(makefile).toMatch(/cargo audit/);
    expect(makefile).toMatch(/pip-audit/);
    expect(readRepoFile(".gitlab-ci.yml")).toMatch(/^ {4}- make audit$/m);
  });

  it("deploy never runs an unpinned npx package (M2-11)", () => {
    const sources = trackedFiles().filter(
      (file) =>
        file.startsWith("scripts/deploy/src/platform/") &&
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts"),
    );
    const text = sources.map((file) => readRepoFile(file)).join("\n");
    expect(text).toMatch(/vercel@\$\{VERCEL_CLI_VERSION\}/);
    expect(text).toMatch(/@railway\/cli@\$\{RAILWAY_CLI_VERSION\}/);
    expect(text).not.toMatch(/@latest|@next/);
    expect(text).toMatch(/export const VERCEL_CLI_VERSION = "\d+\.\d+\.\d+"/);
    expect(text).toMatch(/export const RAILWAY_CLI_VERSION = "\d+\.\d+\.\d+"/);
    // Every npx call in the deploy sources names a pinned package.
    for (const match of text.matchAll(/"npx",\s*\[\s*"--yes",\s*`([^`]+)`/g)) {
      expect(match[1]).toMatch(/@\$\{[A-Z_]+_CLI_VERSION\}$/);
    }
  });
});
