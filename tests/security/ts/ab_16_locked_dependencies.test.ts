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
});
