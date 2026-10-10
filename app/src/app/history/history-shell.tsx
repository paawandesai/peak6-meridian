"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMemo } from "react";

import { loadWalletEvents } from "./history-chain";
import { HistoryView } from "./history-view";
import { AppHeader } from "@/components/app-header";
import { FaucetButton } from "@/components/faucet-button";
import { Providers } from "@/components/providers";
import { useReader } from "@/components/reader-context";
import { useTestMarkets } from "@/components/test-market-context";
import { useAsync } from "@/components/use-async";
import { useNow } from "@/components/use-now";
import { explorerTxUrl } from "@/lib/admin-chain";
import { loadPublicConfig } from "@/lib/config";
import { partitionMarkets } from "@/lib/markets";

function Page() {
  const reader = useReader();
  const nowSecs = useNow();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const config = useMemo(() => loadPublicConfig(), []);
  const { showTestMarkets } = useTestMarkets();
  const marketsAll = useAsync(() => reader.listMarkets(), [reader]);
  const appConfig = useAsync(() => reader.getConfig(), [reader]);
  // P0-1 AC3-4: Filter to session markets; include test markets when toggle is on
  const markets = useMemo(() => {
    if (marketsAll.status !== "ready") return marketsAll;
    const { session, test } = partitionMarkets(marketsAll.value);
    const filtered = showTestMarkets ? [...session, ...test] : session;
    return { ...marketsAll, value: filtered };
  }, [marketsAll, showTestMarkets]);
  // P0-4: Use gPA to find existing OO accounts, don't call getSignaturesForAddress on every PDA
  const events = useAsync(async () => {
    if (publicKey === null) return [];
    // loadWalletEvents uses gPA when no addresses are passed
    return loadWalletEvents(connection, publicKey, config.programId);
  }, [connection, publicKey, config]);
  return (
    <>
      <AppHeader
        nowSecs={nowSecs}
        markets={markets.status === "ready" ? markets.value : null}
        config={appConfig.status === "ready" ? appConfig.value : null}
        currentPath="/history"
      >
        <FaucetButton />
      </AppHeader>
      <main className="mx-auto max-w-5xl px-mer-4 py-mer-6">
        <h2 className="mb-mer-4 text-mer-xl font-semibold">History</h2>
        {events.status === "loading" ? <p>Loading history…</p> : null}
        {events.status === "error" ? (
          <p role="alert">Could not load history: {events.message}</p>
        ) : null}
        {events.status === "ready" ? (
          <HistoryView
            events={events.value}
            markets={markets.status === "ready" ? markets.value : []}
            explorerUrl={(signature) => explorerTxUrl(signature, config)}
          />
        ) : null}
      </main>
    </>
  );
}

export function HistoryShell() {
  return (
    <Providers>
      <Page />
    </Providers>
  );
}
