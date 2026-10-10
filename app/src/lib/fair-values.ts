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
  edgeTone,
  type EdgeTone,
  edgeWord,
  type EdgeWord,
  FAIR_VALUES_PATH,
  ageSecs,
  asOfSecs,
  fairValueSchema,
  fairValuesSchema,
  type FairValue,
  fetchFairValues,
  formatAge,
  isStale,
  NO_UPDATE_STALE_AFTER_SECS,
  REFRESH_MS,
  type StaleReason,
  staleReasons,
} from "./fair-values-core";
import { fetchFairValues, type FairValue, REFRESH_MS } from "./fair-values-core";
import { isDocumentVisible } from "./visibility";

export type FairValues = {
  readonly status: "loading" | "ready" | "unavailable";
  /** By market address. */
  readonly byMarket: Readonly<Record<string, FairValue>>;
  /**
   * When the last read succeeded (unix seconds, wall clock), `null` when none has. A failed poll
   * keeps the last good values and leaves this as it was, so the values read stale once it is
   * over 30 s old (`isStale`, P0-FV).
   */
  readonly lastSuccessSecs: number | null;
};

const INITIAL: FairValues = { status: "loading", byMarket: {}, lastSuccessSecs: null };
const UNAVAILABLE: FairValues = { status: "unavailable", byMarket: {}, lastSuccessSecs: null };

const wallClockSecs = (): number => Math.floor(Date.now() / 1000);

/**
 * Polls fair values every {@link REFRESH_MS} while `enabled`. A failed poll keeps the last good
 * values and their `lastSuccessSecs`, so they read stale once no read has succeeded for 30 s;
 * with nothing ever read the state is `unavailable`, never a made-up number. A tick is skipped
 * while a read is in flight.
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
        lastSuccessSecs: wallClockSecs(),
      };
    } catch {
      return "skip";
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // When disabled and nothing has been read, surface unavailable instead of loading forever.
      setState((previous) => (previous.status === "loading" ? UNAVAILABLE : previous));
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
      // A failed read keeps the last good values and the time they were read.
      setState((previous) =>
        next === "skip" ? (previous.status === "ready" ? previous : UNAVAILABLE) : next,
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
