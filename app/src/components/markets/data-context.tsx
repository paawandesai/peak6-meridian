"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import type { MarketDataSources } from "@/lib/market-data";
import { createMarketDataSources } from "@/lib/market-data";

/** The live-data sources the Markets page reads; absent in tests that do not need them. */
export type MarketSources = {
  readonly data: MarketDataSources | null;
};

const NONE: MarketSources = { data: null };
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

/** Browser sources: the server price route and chain book reads. */
export function BrowserMarketSources({ children }: { readonly children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const sources = useMemo<MarketSources>(
    () => (mounted ? { data: createMarketDataSources() } : NONE),
    [mounted],
  );
  return <MarketSourcesProvider sources={sources}>{children}</MarketSourcesProvider>;
}

export function useMarketSources(): MarketSources {
  return useContext(MarketSourcesContext);
}
