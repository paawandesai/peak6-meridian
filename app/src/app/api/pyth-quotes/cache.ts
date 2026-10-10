/** Shared cache state for pyth-quotes route (extracted to allow test access without violating Next.js route export rules). */
import type { PythQuotesResponse } from "@/lib/pyth-quotes";

const CACHE_TTL_MS = 2_000;

/** Cache keyed by sorted ticker list to prevent cross-contamination (Markets/Trade use different sets). */
export const cache = new Map<string, { data: PythQuotesResponse; at: number }>();

/** In-flight requests keyed by sorted ticker list. */
export const inFlight = new Map<string, Promise<PythQuotesResponse>>();

export { CACHE_TTL_MS };

/** Clears cache and in-flight maps (for tests). */
export function clearCache(): void {
  cache.clear();
  inFlight.clear();
}
