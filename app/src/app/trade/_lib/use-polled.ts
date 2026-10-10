"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Polled<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

/**
 * Runs `load` now and every `intervalMs`, keeping the last good value on a later failure. A tick
 * is skipped while the previous load is in flight, so replies cannot arrive out of order.
 * `refresh` reloads at once (after a confirmed transaction). `load` may change identity freely;
 * pass a changing `key` to restart (a different wallet).
 */
export function usePolled<T>(
  load: () => Promise<T>,
  intervalMs: number,
  key: string,
): { state: Polled<T>; refresh: () => void } {
  const [state, setState] = useState<Polled<T>>({ status: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const runRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    setState({ status: "loading" });
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
    const timer = setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs, key]);

  const refresh = useCallback(() => runRef.current(), []);
  return { state, refresh };
}
