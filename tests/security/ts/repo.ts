import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root. */
export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/** Contents of a repo-relative text file. */
export function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

/** Repo-relative paths of every file tracked by git. */
export function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out.split("\0").filter((path) => path.length > 0);
}

/** True if git would ignore the repo-relative path. */
export function isGitIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", path], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}
