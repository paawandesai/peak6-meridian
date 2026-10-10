"use client";

import { ConnectionContext, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { useStandardWalletAdapters } from "@solana/wallet-standard-wallet-adapter-react";
import { type ReactNode, useEffect, useMemo } from "react";

import { BrowserMarketSources } from "./markets/data-context";
import { DemoWalletBanner } from "./DemoWalletBanner";
import { ReaderProvider } from "./reader-context";
import { TestMarketProvider } from "./test-market-context";
import { createReader } from "@/lib/chain";
import { loadPublicConfig } from "@/lib/config";
import { registerDemoWallet, setDemoWalletRpcUrl } from "@/lib/demo-wallet";
import { sharedConnection } from "@/lib/rpc";

if (typeof window !== "undefined") {
  registerDemoWallet();
}

/** Wallet adapters (Phantom, Solflare, demo wallet on devnet) plus the read-only chain reader. */
export function Providers({ children }: { readonly children: ReactNode }) {
  const config = useMemo(() => loadPublicConfig(), []);
  const reader = useMemo(() => createReader(config), [config]);
  const adapters = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  const wallets = useStandardWalletAdapters(adapters);
  // One Connection app-wide: sharedConnection (with 429 retry) is used by reader, books, demo wallet,
  // and exposed via wallet-adapter's ConnectionContext for status/history/portfolio/trade/admin.
  const connection = useMemo(() => sharedConnection(config.rpcUrl), [config.rpcUrl]);
  const connectionState = useMemo(() => ({ connection }), [connection]);
  // Tell the demo wallet which RPC URL to use (it will use sharedConnection)
  useEffect(() => {
    setDemoWalletRpcUrl(config.rpcUrl);
  }, [config.rpcUrl]);
  return (
    <ConnectionContext.Provider value={connectionState}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <DemoWalletBanner />
          <ReaderProvider reader={reader}>
            <TestMarketProvider>
              <BrowserMarketSources>{children}</BrowserMarketSources>
            </TestMarketProvider>
          </ReaderProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionContext.Provider>
  );
}
