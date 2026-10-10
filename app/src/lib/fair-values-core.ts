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
  /**
   * The service marks a value stale when its inputs are old; it keeps publishing the last value
   * with `stale: true` rather than dropping the market, and the app shows it flagged, not hidden.
   */
  stale: z.boolean(),
});

export const fairValuesSchema = z.array(fairValueSchema).max(500);

export type FairValue = z.infer<typeof fairValueSchema>;

export const FAIR_VALUES_PATH = "/api/fair-values";
/** Fair values are re-read at least this often while a market is open (M3-03 AC2). */
export const REFRESH_MS = 5_000;
/**
 * With no successful read of {@link FAIR_VALUES_PATH} for longer than this, every value shown reads
 * stale (the pricing service unreachable, the route failing, the network down). The value's own
 * `as_of` (its spot time) is information only: the service owns staleness and sends `stale`.
 */
export const NO_UPDATE_STALE_AFTER_SECS = 30;

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

/** The value's `as_of` in unix seconds. */
export function asOfSecs(value: FairValue): number {
  return Math.floor(Date.parse(value.as_of) / 1000);
}

/** Seconds from `asOf` to `nowSecs` (never negative: a clock skewed ahead reads as 0). */
export function ageSecs(asOf: number, nowSecs: number): number {
  return Math.max(0, Math.floor(nowSecs) - asOf);
}

/** `42 s`, `3 min`, `2 h`: whole units, rounded down, so an age is never understated as fresher. */
export function formatAge(secs: number): string {
  if (secs < 60) return `${secs} s`;
  if (secs < 3_600) return `${Math.floor(secs / 60)} min`;
  return `${Math.floor(secs / 3_600)} h`;
}

/**
 * The edge's tone, for colour only (the word is always written): a cheap YES (market under fair)
 * reads in the YES colour (buying YES is the side with the edge), a rich YES in the NO colour.
 */
export type EdgeTone = "yes" | "no" | "neutral";

export function edgeTone(edge: number): EdgeTone {
  return edge < 0 ? "yes" : edge > 0 ? "no" : "neutral";
}

/**
 * Why a value reads stale: the app has had no successful read for over
 * {@link NO_UPDATE_STALE_AFTER_SECS} (`secs` is that time, `null` when nothing was ever read), or
 * the service flagged it (`stale: true`).
 */
export type StaleReason =
  { readonly kind: "no-update"; readonly secs: number | null } | { readonly kind: "server" };

/**
 * Every reason `value` is stale, given when the app last read fair values successfully
 * (`lastSuccessSecs`, unix seconds) and the page's clock; empty means fresh. The spot `as_of`
 * never enters the decision: the server owns that rule (in the weekend demo the spot is hours
 * old on purpose and the server sends `stale: false`).
 */
export function staleReasons(
  value: FairValue,
  lastSuccessSecs: number | null,
  nowSecs: number,
): StaleReason[] {
  const reasons: StaleReason[] = [];
  const sinceSuccess = lastSuccessSecs === null ? null : ageSecs(lastSuccessSecs, nowSecs);
  if (sinceSuccess === null || sinceSuccess > NO_UPDATE_STALE_AFTER_SECS) {
    reasons.push({ kind: "no-update", secs: sinceSuccess });
  }
  if (value.stale) reasons.push({ kind: "server" });
  return reasons;
}

/** Stale iff the service flagged it or the last successful read is over 30 s old (P0-FV). */
export function isStale(
  value: FairValue,
  lastSuccessSecs: number | null,
  nowSecs: number,
): boolean {
  return staleReasons(value, lastSuccessSecs, nowSecs).length > 0;
}
