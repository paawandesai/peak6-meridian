"use client";

import { AppHeader } from "./app-header";
import { MarketsView } from "./markets-view";
import { Providers } from "./providers";
import { useReader } from "./reader-context";
import { useAsync } from "./use-async";
import { useNow } from "./use-now";

/** Header data: the markets (for the next close) and the config (for the pause banner). */
function Shell() {
  const reader = useReader();
  const nowSecs = useNow();
  const markets = useAsync(() => reader.listMarkets(), [reader]);
  const config = useAsync(() => reader.getConfig(), [reader]);
  return (
    <>
      <AppHeader
        nowSecs={nowSecs}
        markets={markets.status === "ready" ? markets.value : null}
        config={config.status === "ready" ? config.value : null}
      />
      <main className="mx-auto max-w-3xl px-mer-4 py-mer-6">
        <h2 className="sr-only">Markets</h2>
        <MarketsView />
      </main>
    </>
  );
}

export function AppShell() {
  return (
    <Providers>
      <Shell />
    </Providers>
  );
}
