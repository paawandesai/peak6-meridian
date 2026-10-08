"use client";

import { useEffect, useState } from "react";

/**
 * The current unix time in whole seconds, ticking every second, or `null` until the component has
 * mounted. The server render and the first client render both see `null`, so a page that shows
 * the time never has a hydration mismatch.
 */
export function useNow(intervalMs = 1_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
