/** Repo-relative directory holding the Switchboard feed definitions (architecture.md). */
export const FEEDS_DIR = "oracle/feeds";

/**
 * Package identity.
 *
 * M1-01 placeholder: the feed scripts arrive with the Switchboard spike (M1-09).
 */
export function scriptsInfo(): { readonly name: string; readonly feedsDir: string } {
  return { name: "switchboard-scripts", feedsDir: FEEDS_DIR };
}
