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

function Page() {
  const reader = useReader();
  const nowSecs = useNow();
  const { connection } = useConnection();
  const config = useMemo(() => loadPublicConfig(), []);
  const markets = useAsync(() => reader.listMarkets(), [reader]);
  const appConfig = useAsync(() => reader.getConfig(), [reader]);
  const data = useAsync(
    async () => loadStatusData(connection, await reader.listMarkets(), config.programId),
    [reader, connection, config],
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
