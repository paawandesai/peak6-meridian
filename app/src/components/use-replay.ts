"use client";

import { useEffect, useState } from "react";

import { parseReplayParam, REPLAY_PARAM, type ReplayState } from "@/lib/replay";

/**
 * The page's replay state from `?replay=`, or `null` until mount. It reads `window.location`
 * after mount (not `useSearchParams`), so no page needs a Suspense boundary for it and the
 * server HTML and first client render always match. Replay applies to Markets (`/`) and Trade
 * (`/trade/...`) only; other pages show live data and ignore the parameter.
 */
export function useReplay(): ReplayState | null {
  const [state, setState] = useState<ReplayState | null>(null);
  useEffect(() => {
    const read = () => {
      const { pathname, search } = window.location;
      const applies = pathname === "/" || pathname.startsWith("/trade/");
      const raw = applies ? new URLSearchParams(search).get(REPLAY_PARAM) : null;
      setState(parseReplayParam(raw, Math.floor(Date.now() / 1000)));
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  return state;
}
