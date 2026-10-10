"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useMemo } from "react";

import { loadStatusData } from "./status-chain";
import { StatusView } from "./status-view";
import { AppHeader } from "@/components/app-header";
import { FaucetButton } from "@/components/faucet-button";
import { Providers } from "@/components/providers";
import { useReader } from "@/components/reader-context";
import { useAsync } from "@/components/use-async";
import { useNow } from "@/components/use-now";
import { loadPublicConfig } from "@/lib/config";
import { dedupe } from "@/lib/rpc";

/** Status data cached for 30 s to limit RPC load on refresh. */
const STATUS_CACHE_MS = 30_000;

function Page() {
  const reader = useReader();
  const nowSecs = useNow();
  const { connection } = useConnection();
  const config = useMemo(() => loadPublicConfig(), []);
  const markets = useAsync(() => reader.listMarkets(), [reader]);
  const appConfig = useAsync(() => reader.getConfig(), [reader]);
  const loadStatusCached = useMemo(
    () =>
      dedupe(async () => {
        const markets = await reader.listMarkets();
        return loadStatusData(connection, markets, config.programId);
      }, STATUS_CACHE_MS),
    [reader, connection, config],
  );
  const data = useAsync(() => loadStatusCached(), [loadStatusCached]);
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
      <main className="mx-auto max-w-5xl px-mer-4 py-mer-6">
        <h2 className="mb-mer-4 text-mer-xl font-semibold">Status</h2>
        {data.status === "loading" ? <p>Loading status…</p> : null}
        {data.status === "error" ? <p role="alert">Could not load status: {data.message}</p> : null}
        {data.status === "ready" ? <StatusView data={data.value} /> : null}
      </main>
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
