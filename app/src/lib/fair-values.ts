"use client";

/**
 * Fair values React hook (M3-03, FR-24 display). The hook polls fair values from the proxy at a
 * regular interval. Re-exports the pure utilities from fair-values-core for convenience.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// Re-export everything from fair-values-core for convenience
export {
  edgeCents,
  edgeText,
  edgeWord,
  type EdgeWord,
  FAIR_VALUES_PATH,
  fairValueSchema,
  fairValuesSchema,
  type FairValue,
  fetchFairValues,
  isStale,
  REFRESH_MS,
  STALE_AFTER_SECS,
} from "./fair-values-core";
import { fetchFairValues, type FairValue, REFRESH_MS } from "./fair-values-core";
import { isDocumentVisible } from "./visibility";

export type FairValues = {
  readonly status: "loading" | "ready" | "unavailable";
  /** By market address. */
  readonly byMarket: Readonly<Record<string, FairValue>>;
  /** The last refresh failed; the values shown are the last good ones and must read as stale. */
  readonly refreshFailed: boolean;
};

const INITIAL: FairValues = { status: "loading", byMarket: {}, refreshFailed: false };

/**
 * Polls fair values every {@link REFRESH_MS} while `enabled`. A failed poll keeps the last good
 * values and sets `refreshFailed` so they are labelled stale; with nothing ever read the state is
 * `unavailable`, never a made-up number. A tick is skipped while a read is in flight.
 */
export function useFairValues(
  options: {
    readonly enabled?: boolean;
    readonly intervalMs?: number;
    readonly fetcher?: () => Promise<FairValue[]>;
  } = {},
): FairValues {
  const { enabled = true, intervalMs = REFRESH_MS } = options;
  const [state, setState] = useState<FairValues>(INITIAL);
  const fetcherRef = useRef(options.fetcher ?? fetchFairValues);
  fetcherRef.current = options.fetcher ?? fetchFairValues;

  const load = useCallback(async (): Promise<FairValues | "skip"> => {
    try {
      const values = await fetcherRef.current();
      return {
        status: "ready",
        byMarket: Object.fromEntries(values.map((value) => [value.market, value])),
        refreshFailed: false,
      };
    } catch {
      return "skip";
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // When disabled and nothing has been read, surface unavailable instead of loading forever.
      setState((previous) =>
        previous.status === "loading"
          ? { status: "unavailable", byMarket: {}, refreshFailed: false }
          : previous,
      );
      return undefined;
    }
    let cancelled = false;
    let inFlight = false;
    const run = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const next = await load();
      inFlight = false;
      if (cancelled) return;
      setState((previous) =>
        next === "skip"
          ? previous.status === "ready"
            ? { ...previous, refreshFailed: true }
            : { status: "unavailable", byMarket: {}, refreshFailed: true }
          : next,
      );
    };
    void run();
    // A hidden tab skips ticks (P1-2), like the account feed and the other pollers.
    const timer = setInterval(() => {
      if (isDocumentVisible()) void run();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, intervalMs, load]);

  return state;
}
