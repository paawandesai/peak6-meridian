/**
 * Fair values schemas and utilities (M3-03, FR-24 display). Pure functions and schemas only, no
 * React hooks, so this module is safe to import server-side. Money is integer cents throughout:
 * edge = market − fair, signed, never a float.
 */
import { z } from "zod";

export const fairValueSchema = z.object({
  market: z.string().min(1).max(64),
  ticker: z.string().min(1).max(8),
  strike_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** YES fair value in whole cents, 1 to 99 (domain.md § Fair value). */
  fair_cents: z.number().int().min(1).max(99),
  sigma: z.number().finite().nonnegative(),
  spot: z.union([z.string().regex(/^\d+(\.\d+)?$/), z.number().finite().nonnegative()]),
  as_of: z.iso.datetime({ offset: true }),
  /** The service marks a value stale when its spot is older than 10 s. */
  stale: z.boolean(),
});

export const fairValuesSchema = z.array(fairValueSchema).max(500);

export type FairValue = z.infer<typeof fairValueSchema>;

export const FAIR_VALUES_PATH = "/api/fair-values";
/** Fair values are re-read at least this often while a market is open (M3-03 AC2). */
export const REFRESH_MS = 5_000;
/** A value older than this is shown with a stale label even if the service did not flag it. */
export const STALE_AFTER_SECS = 10;

/** Reads the proxy; throws plain words (never the response body) on failure. */
export async function fetchFairValues(
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
): Promise<FairValue[]> {
  const response = await fetcher(FAIR_VALUES_PATH, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      response.status === 503
        ? "fair values are not configured for this app"
        : `fair values could not be read (${response.status})`,
    );
  }
  const parsed = fairValuesSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("fair values came back in an unexpected shape");
  return parsed.data;
}

/** Edge = market − fair, signed, integer cents. Positive means the market is rich. */
export function edgeCents(marketYesCents: number, fairCents: number): number {
  return marketYesCents - fairCents;
}

export type EdgeWord = "rich" | "cheap" | "fair";

export function edgeWord(edge: number): EdgeWord {
  return edge > 0 ? "rich" : edge < 0 ? "cheap" : "fair";
}

/** `Edge +4¢ (rich)`, `Edge −3¢ (cheap)` (U+2212), `Edge 0¢ (fair)`: the word is always written. */
export function edgeText(edge: number): string {
  const sign = edge > 0 ? "+" : edge < 0 ? "−" : "";
  return `Edge ${sign}${Math.abs(edge)}¢ (${edgeWord(edge)})`;
}

/** A value is stale when the service says so or its `as_of` is older than {@link STALE_AFTER_SECS}. */
export function isStale(value: FairValue, nowSecs: number): boolean {
  if (value.stale) return true;
  return nowSecs - Math.floor(Date.parse(value.as_of) / 1000) > STALE_AFTER_SECS;
}
