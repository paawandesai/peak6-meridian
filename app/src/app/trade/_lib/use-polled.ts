"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { LiveRead, LiveSource } from "@/lib/account-feed";
import { isDocumentVisible, onDocumentVisible } from "@/lib/visibility";

export type Polled<T> = LiveRead<T>;

/**
 * Runs `load` now and every `intervalMs`, keeping the last good value on a later failure. A tick
 * is skipped while the previous load is in flight, so replies cannot arrive out of order, and
 * while the tab is hidden (it reloads once when shown). `refresh` reloads at once (after a
 * confirmed transaction). `load` may change identity freely; pass a changing `key` to restart
 * (a different wallet).
 *
 * P1-2: with a `source` (account subscriptions on the shared feed) nothing is polled here: the
 * feed pushes changes and owns the fallback polling. `live` is true while pushes are flowing.
 */
export function usePolled<T>(
  load: () => Promise<T>,
  intervalMs: number,
  key: string,
  source: LiveSource<T> | null = null,
): { state: Polled<T>; refresh: () => void; live: boolean } {
  const [state, setState] = useState<Polled<T>>({ status: "loading" });
  const [live, setLive] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const runRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setLive(false);
    if (source !== null) {
      const update = (): void => {
        if (cancelled) return;
        const next = source.read();
        // Keep showing the last good value if there is one.
        setState((previous) =>
          next.status !== "ready" && previous.status === "ready" ? previous : next,
        );
        setLive(source.isLive());
      };
      runRef.current = () => source.refresh();
      const stop = source.subscribe(update);
      update();
      return () => {
        cancelled = true;
        stop();
      };
    }
    let inFlight = false;
    const run = (): void => {
      if (inFlight) return;
      inFlight = true;
      loadRef
        .current()
        .then(
          (value) => !cancelled && setState({ status: "ready", value }),
          (error: unknown) => {
            if (cancelled) return;
            const message = error instanceof Error ? error.message : String(error);
            // Keep showing the last good value if there is one.
            setState((previous) =>
              previous.status === "ready" ? previous : { status: "error", message },
            );
          },
        )
        .finally(() => {
          inFlight = false;
        });
    };
    runRef.current = run;
    run();
    const timer = setInterval(() => {
      if (isDocumentVisible()) run();
    }, intervalMs);
    const stopVisible = onDocumentVisible(run);
    return () => {
      cancelled = true;
      clearInterval(timer);
      stopVisible();
    };
  }, [intervalMs, key, source]);

  const refresh = useCallback(() => runRef.current(), []);
  return { state, refresh, live };
}
