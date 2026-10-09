"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import type { MarketDataSources } from "@/lib/market-data";
import { createMarketDataSources } from "@/lib/market-data";
import { createOpenTimeSource, type OpenTimeSource } from "@/lib/market-open";
import { loadPublicConfig } from "@/lib/config";

/** The live-data sources the Markets page reads; absent in tests that do not need them. */
export type MarketSources = {
  readonly data: MarketDataSources | null;
  readonly openTimes: OpenTimeSource | null;
};

const NONE: MarketSources = { data: null, openTimes: null };
const MarketSourcesContext = createContext<MarketSources>(NONE);

export function MarketSourcesProvider({
  sources,
  children,
}: {
  readonly sources: MarketSources;
  readonly children: ReactNode;
}) {
  return <MarketSourcesContext.Provider value={sources}>{children}</MarketSourcesContext.Provider>;
}

/** Browser sources: the server price route and chain book reads, plus creation times. */
export function BrowserMarketSources({ children }: { readonly children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const sources = useMemo<MarketSources>(
    () =>
      mounted
        ? { data: createMarketDataSources(), openTimes: createOpenTimeSource(loadPublicConfig()) }
        : NONE,
    [mounted],
  );
  return <MarketSourcesProvider sources={sources}>{children}</MarketSourcesProvider>;
}

export function useMarketSources(): MarketSources {
  return useContext(MarketSourcesContext);
}
