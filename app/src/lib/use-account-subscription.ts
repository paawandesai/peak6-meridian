"use client";

import type { AccountInfo, Commitment, Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";

export type Subscribed<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

type SubscriptionRef = {
  keys: Set<string>;
  subscriptionIds: Map<string, number>;
  activeCount: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastPollInFlight: boolean;
};

const subscriptions = new Map<string, SubscriptionRef>();

function getSubscriptionKey(keys: readonly PublicKey[]): string {
  return keys
    .map((k) => k.toBase58())
    .sort()
    .join(",");
}

/**
 * Subscribes to account changes for a list of pubkeys, with automatic fallback to polling.
 *
 * - Uses connection.onAccountChange when WebSocket is available
 * - Falls back to polling at `intervalMs` when WS unavailable or errors
 * - Deduplicates subscriptions across components mounting the same keys
 * - Cleans up on unmount and when tab is hidden (visibilitychange)
 *
 * @param connection The Solana connection instance
 * @param keys Array of PublicKey to subscribe to
 * @param load Function to fetch current state (used for polling fallback and initial load)
 * @param intervalMs Polling interval in milliseconds (fallback mode)
 * @param key Unique key to restart the subscription (e.g., wallet pubkey)
 * @param commitment Commitment level for subscriptions (default: "confirmed")
 */
export function useAccountSubscription<T>(
  connection: Connection | null,
  keys: readonly PublicKey[],
  load: () => Promise<T>,
  intervalMs: number,
  key: string,
  commitment: Commitment = "confirmed",
): { state: Subscribed<T>; refresh: () => void } {
  const [state, setState] = useState<Subscribed<T>>({ status: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const runRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (connection === null || keys.length === 0) {
      setState({ status: "loading" });
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const subKey = getSubscriptionKey(keys);

    const run = (): void => {
      if (inFlight) return;
      inFlight = true;
      const promise = loadRef.current();
      if (promise === undefined || promise === null) {
        inFlight = false;
        return;
      }
      promise
        .then(
          (value) => !cancelled && setState({ status: "ready", value }),
          (error: unknown) => {
            if (cancelled) return;
            const message = error instanceof Error ? error.message : String(error);
            // Keep showing the last good value if there is one
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

    // Initial load
    run();

    let subRef = subscriptions.get(subKey);
    const isFirstMount = subRef === undefined;

    if (isFirstMount) {
      subRef = {
        keys: new Set(keys.map((k) => k.toBase58())),
        subscriptionIds: new Map(),
        activeCount: 0,
        pollTimer: null,
        lastPollInFlight: false,
      };
      subscriptions.set(subKey, subRef);
    }

    subRef.activeCount += 1;

    // Try WebSocket subscriptions
    let usingWebSocket = false;
    const setupSubscriptions = async (): Promise<void> => {
      if (cancelled || subRef === undefined) return;

      try {
        for (const pubkey of keys) {
          const keyStr = pubkey.toBase58();
          if (!subRef.subscriptionIds.has(keyStr)) {
            const subscriptionId = connection.onAccountChange(
              pubkey,
              (accountInfo: AccountInfo<Buffer> | null) => {
                if (!cancelled) {
                  run();
                }
              },
              commitment,
            );
            subRef.subscriptionIds.set(keyStr, subscriptionId);
          }
        }
        usingWebSocket = true;
      } catch (error) {
        // WebSocket subscription failed, fall back to polling
        usingWebSocket = false;
        if (subRef.pollTimer === null && !cancelled) {
          subRef.pollTimer = setInterval(() => {
            if (subRef !== undefined && !subRef.lastPollInFlight) {
              subRef.lastPollInFlight = true;
              run();
              subRef.lastPollInFlight = false;
            }
          }, intervalMs);
        }
      }
    };

    if (isFirstMount) {
      void setupSubscriptions();
    }

    // Fallback to polling if WebSocket not established after initial timeout
    const fallbackTimer = setTimeout(() => {
      if (!usingWebSocket && subRef !== undefined && subRef.pollTimer === null && !cancelled) {
        subRef.pollTimer = setInterval(() => {
          if (subRef !== undefined && !subRef.lastPollInFlight) {
            subRef.lastPollInFlight = true;
            run();
            subRef.lastPollInFlight = false;
          }
        }, intervalMs);
      }
    }, 2000);

    // Cleanup when tab is hidden
    const handleVisibilityChange = (): void => {
      if (document.hidden && subRef !== undefined) {
        // Remove WebSocket subscriptions when hidden
        for (const [keyStr, subscriptionId] of subRef.subscriptionIds.entries()) {
          try {
            void connection.removeAccountChangeListener(subscriptionId);
          } catch {
            // Ignore errors during cleanup
          }
        }
        subRef.subscriptionIds.clear();

        // Stop polling
        if (subRef.pollTimer !== null) {
          clearInterval(subRef.pollTimer);
          subRef.pollTimer = null;
        }
      } else if (!document.hidden && subRef !== undefined && subRef.activeCount > 0) {
        // Re-establish subscriptions when visible again
        void setupSubscriptions();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      if (subRef === undefined) return;

      subRef.activeCount -= 1;

      if (subRef.activeCount === 0) {
        // Last component unmounted, clean up all subscriptions
        for (const subscriptionId of subRef.subscriptionIds.values()) {
          try {
            void connection.removeAccountChangeListener(subscriptionId);
          } catch {
            // Ignore errors during cleanup
          }
        }
        subRef.subscriptionIds.clear();

        if (subRef.pollTimer !== null) {
          clearInterval(subRef.pollTimer);
          subRef.pollTimer = null;
        }

        subscriptions.delete(subKey);
      }
    };
  }, [connection, keys, intervalMs, key, commitment]);

  const refresh = useCallback(() => runRef.current(), []);
  return { state, refresh };
}
