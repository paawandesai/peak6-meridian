/** Repo-relative directory holding the Switchboard feed definitions (architecture.md). */
export const FEEDS_DIR = "oracle/feeds";

/** Package identity. */
export function scriptsInfo(): { readonly name: string; readonly feedsDir: string } {
  return { name: "switchboard-scripts", feedsDir: FEEDS_DIR };
}

export * from "./decimal";
export * from "./feeds";
export * from "./spike";
