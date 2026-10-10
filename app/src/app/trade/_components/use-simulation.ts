"use client";

import { useEffect, useRef, useState } from "react";

import { summarize, type Summary } from "../_lib/summary";
import type { TradeActions, TradeRequest } from "../_lib/tx";

export type SimState =
  | { readonly status: "idle" }
  | { readonly status: "simulating" }
  | { readonly status: "ok"; readonly summary: Summary }
  | { readonly status: "failed"; readonly reason: string };

export const NOTHING_TO_FILL =
  "nothing would fill: the book has no matching orders. Use a limit order to rest one";

/**
 * Simulates `request` whenever it (or the book it was priced against, via `bookKey`) changes,
 * after `debounceMs`. A reply for a superseded request is dropped, so the sign button can never
 * be enabled by a stale simulation. `null` means there is nothing to simulate.
 */
export function useSimulation(
  actions: TradeActions | null,
  request: TradeRequest | null,
  user: string | null,
  bookKey: string,
  debounceMs = 250,
): SimState {
  // The result is stored with the key it answers; a result for any other key is never shown, so
  // the render right after an input change cannot enable signing from the previous simulation.
  const [stored, setStored] = useState<{ key: string | null; state: SimState }>({
    key: null,
    state: { status: "idle" },
  });
  const requestRef = useRef(request);
  requestRef.current = request;
  const key =
    request === null || actions === null || user === null
      ? null
      : `${request.intent}|${request.kind}|${request.priceCents}|${request.qty}|${user}|${bookKey}`;

  useEffect(() => {
    const current = requestRef.current;
    if (key === null || current === null || actions === null || user === null) {
      return undefined;
    }
    let cancelled = false;
    const set = (state: SimState): void => setStored({ key, state });
    set({ status: "simulating" });
    const timer = setTimeout(() => {
      actions.simulate(current).then(
        (outcome) => {
          if (cancelled) return;
          if (!outcome.ok) {
            set({ status: "failed", reason: outcome.reason });
            return;
          }
          const summary = summarize({
            intent: current.intent,
            kind: current.kind,
            priceCents: current.priceCents,
            qty: current.qty,
            events: outcome.events,
            user,
          });
          set(
            summary.contracts < 1n
              ? { status: "failed", reason: NOTHING_TO_FILL }
              : { status: "ok", summary },
          );
        },
        (error: unknown) => {
          if (!cancelled) {
            set({
              status: "failed",
              reason: error instanceof Error ? error.message : "the simulation could not run",
            });
          }
        },
      );
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, actions, user, debounceMs]);

  if (key === null) return { status: "idle" };
  return stored.key === key ? stored.state : { status: "simulating" };
}
