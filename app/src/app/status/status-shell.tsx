"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useMemo } from "react";

import { loadStatusData } from "./status-chain";
import { StatusView } from "./status-view";
import { AppHeader } from "@/components/app-header";
import { BottomTabBar } from "@/components/app-shell/bottom-tab-bar";
import { FaucetButton } from "@/components/faucet-button";
import { Providers } from "@/components/providers";
import { useReader } from "@/components/reader-context";
import { useTestMarkets } from "@/components/test-market-context";
import { TestMarketToggle } from "@/components/ui";
import { useAsync } from "@/components/use-async";
import { useNow } from "@/components/use-now";
import { loadPublicConfig } from "@/lib/config";
import { partitionMarkets } from "@/lib/markets";

function Page() {
  const reader = useReader();
  const nowSecs = useNow();
  const { connection } = useConnection();
  const { showTestMarkets, setShowTestMarkets } = useTestMarkets();
  const config = useMemo(() => loadPublicConfig(), []);
  const marketsAll = useAsync(() => reader.listMarkets(), [reader]);
  // P0-1 AC3-4: Filter to session markets only (test markets hidden by default)
  const { testMarketCount, markets } = useMemo(() => {
    if (marketsAll.status !== "ready") return { testMarketCount: 0, markets: marketsAll };
    const { session, test } = partitionMarkets(marketsAll.value);
    const filtered = showTestMarkets ? [...session, ...test] : session;
    return { testMarketCount: test.length, markets: { ...marketsAll, value: filtered } };
  }, [marketsAll, showTestMarkets]);
  const appConfig = useAsync(() => reader.getConfig(), [reader]);
  const data = useAsync(
    async () => {
      const all = await reader.listMarkets();
      const { session, test } = partitionMarkets(all);
      const filtered = showTestMarkets ? [...session, ...test] : session;
      return loadStatusData(connection, filtered, config.programId);
    },
    [reader, connection, config, showTestMarkets],
  );
  return (
    <>
      <AppHeader
        nowSecs={nowSecs}
        markets={markets.status === "ready" ? markets.value : null}
        config={appConfig.status === "ready" ? appConfig.value : null}
        currentPath="/status"
      >
        <FaucetButton />
      </AppHeader>
      <main className="mx-auto max-w-5xl px-mer-4 py-mer-6 pb-20 md:pb-mer-6">
        <h2 className="mb-mer-4 text-mer-xl font-semibold">Status</h2>
        {testMarketCount > 0 ? (
          <div className="mb-mer-4">
            <TestMarketToggle
              testMarketCount={testMarketCount}
              showTestMarkets={showTestMarkets}
              onToggle={() => setShowTestMarkets(!showTestMarkets)}
            />
          </div>
        ) : null}
        {data.status === "loading" ? <p>Loading status…</p> : null}
        {data.status === "error" ? <p role="alert">Could not load status: {data.message}</p> : null}
        {data.status === "ready" ? <StatusView data={data.value} /> : null}
      </main>
      <BottomTabBar />
    </>
  );
}

export function StatusShell() {
  return (
    <Providers>
      <Page />
    </Providers>
  );
}
