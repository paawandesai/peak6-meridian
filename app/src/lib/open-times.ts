"use client";

/**
 * Market open times hook (P1-4; D-050): polls the automation creation-time index through the
 * proxy, one request for every market. A failed read keeps the last good times (a creation time
 * never changes once known); with nothing ever read the state is `unavailable`, which the UI
 * shows as "Open time unavailable", never a made-up time.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchOpenTimes,
  OPEN_TIMES_REFRESH_MS,
  openTimeOf,
  type OpenTime,
  type OpenTimes,
} from "./open-times-core";

export type OpenTimesState = {
  readonly status: "loading" | "ready" | "unavailable";
  /** What to show for one market (see `OpenTime`). */
  readonly openTime: (market: string) => OpenTime;
};

const loading: OpenTimesState = { status: "loading", openTime: () => null };
const unavailable: OpenTimesState = { status: "unavailable", openTime: () => "unavailable" };

function readyState(times: OpenTimes): OpenTimesState {
  return { status: "ready", openTime: (market) => openTimeOf(times, market) };
}

export function useOpenTimes(
  options: {
    readonly intervalMs?: number;
    readonly fetcher?: () => Promise<OpenTimes>;
  } = {},
): OpenTimesState {
  const { intervalMs = OPEN_TIMES_REFRESH_MS } = options;
  const [state, setState] = useState<OpenTimesState>(loading);
  const fetcherRef = useRef(options.fetcher ?? fetchOpenTimes);
  fetcherRef.current = options.fetcher ?? fetchOpenTimes;

  const load = useCallback(async (): Promise<OpenTimes | null> => {
    try {
      return await fetcherRef.current();
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    // Every time ever read: a creation time never changes, so a service that has just restarted
    // and is still rebuilding its index does not blank times the page already showed.
    let known: Record<string, number> = {};
    const run = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const next = await load();
      inFlight = false;
      if (cancelled) return;
      if (next !== null) known = { ...known, ...next.byMarket };
      const merged = next === null ? null : { ready: next.ready, byMarket: known };
      setState((previous) =>
        merged !== null ? readyState(merged) : previous.status === "ready" ? previous : unavailable,
      );
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs, load]);

  return state;
}
