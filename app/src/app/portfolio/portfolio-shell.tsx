"use client";

import { PortfolioView } from "./portfolio-view";
import { AppHeader } from "@/components/app-header";
import { FaucetButton } from "@/components/faucet-button";
import { Providers } from "@/components/providers";
import { useReader } from "@/components/reader-context";
import { useAsync } from "@/components/use-async";
import { useNow } from "@/components/use-now";

/** The same header as the Markets shell (UI-02), around the Portfolio page. */
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
      >
        <FaucetButton />
      </AppHeader>
      <main className="mx-auto max-w-5xl px-mer-4 py-mer-6">
        <h2 className="mb-mer-4 text-mer-lg font-semibold">Portfolio</h2>
        <PortfolioView nowSecs={nowSecs} />
      </main>
    </>
  );
}

export function PortfolioShell() {
  return (
    <Providers>
      <Shell />
    </Providers>
  );
}
