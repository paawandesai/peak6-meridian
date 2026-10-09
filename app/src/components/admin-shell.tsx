"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMemo } from "react";

import { AdminOverride } from "./admin-override/admin-override";
import { AdminView } from "./admin-view";
import { AppHeader } from "./app-header";
import { FaucetButton } from "./faucet-button";
import { Providers } from "./providers";
import { useReader } from "./reader-context";
import { useAsync } from "./use-async";
import { useNow } from "./use-now";
import { createAdminActions, explorerTxUrl, type AdminActions } from "@/lib/admin-chain";
import { loadPublicConfig } from "@/lib/config";

/** Actions that fail with a clear message until the wallet can sign. */
const NO_WALLET: AdminActions = {
  addStrike: () => Promise.reject(new Error("wallet not connected")),
  setPaused: () => Promise.reject(new Error("wallet not connected")),
};

function Page() {
  const reader = useReader();
  const nowSecs = useNow();
  const { connection } = useConnection();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const config = useMemo(() => loadPublicConfig(), []);
  const markets = useAsync(() => reader.listMarkets(), [reader]);
  const appConfig = useAsync(() => reader.getConfig(), [reader]);
  const actions = useMemo(
    () =>
      publicKey === null || signTransaction === undefined || signAllTransactions === undefined
        ? NO_WALLET
        : createAdminActions(
            connection,
            { publicKey, signTransaction, signAllTransactions },
            config,
          ),
    [connection, publicKey, signTransaction, signAllTransactions, config],
  );
  return (
    <>
      <AppHeader
        nowSecs={nowSecs}
        markets={markets.status === "ready" ? markets.value : null}
        config={appConfig.status === "ready" ? appConfig.value : null}
        currentPath="/admin"
      >
        <FaucetButton />
      </AppHeader>
      <main className="mx-auto max-w-3xl px-mer-4 py-mer-6">
        <h2 className="mb-mer-4 text-mer-xl font-semibold">Admin</h2>
        <AdminOverride nowSecs={nowSecs} />
        <AdminView
          actions={actions}
          nowSecs={nowSecs}
          explorerUrl={(signature) => explorerTxUrl(signature, config)}
        />
      </main>
    </>
  );
}

export function AdminShell() {
  return (
    <Providers>
      <Page />
    </Providers>
  );
}
