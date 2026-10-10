"use client";

import { WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { useStandardWalletAdapters } from "@solana/wallet-standard-wallet-adapter-react";
import type { Connection } from "@solana/web3.js";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  type Context,
} from "react";

import { BrowserMarketSources } from "./markets/data-context";
import { DemoWalletBanner } from "./DemoWalletBanner";
import { ReaderProvider } from "./reader-context";
import { createReader } from "@/lib/chain";
import { loadPublicConfig } from "@/lib/config";
import { registerDemoWallet, setDemoWalletRpcUrl } from "@/lib/demo-wallet";
import { sharedConnection } from "@/lib/rpc";

/** Type from @solana/wallet-adapter-react for ConnectionContext. */
interface ConnectionContextState {
  connection: Connection;
}

/** Custom connection context that uses sharedConnection for app-wide Connection instance. */
const SharedConnectionContext = createContext<ConnectionContextState | undefined>(undefined);

/** Hook that returns sharedConnection, matching the wallet-adapter useConnection() API. */
export function useConnection(): ConnectionContextState {
  const context = useContext(
    SharedConnectionContext as Context<ConnectionContextState | undefined>,
  );
  if (context === undefined) {
    throw new Error("useConnection must be used within SharedConnectionProvider");
  }
  return context;
}

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
  // and now also exposed via useConnection() for status/history/portfolio/trade.
  const connection = useMemo(() => sharedConnection(config.rpcUrl), [config.rpcUrl]);
  const connectionState = useMemo(() => ({ connection }), [connection]);
  // Tell the demo wallet which RPC URL to use (it will use sharedConnection)
  useEffect(() => {
    setDemoWalletRpcUrl(config.rpcUrl);
  }, [config.rpcUrl]);
  return (
    <SharedConnectionContext.Provider value={connectionState}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <DemoWalletBanner />
          <ReaderProvider reader={reader}>
            <BrowserMarketSources>{children}</BrowserMarketSources>
          </ReaderProvider>
        </WalletModalProvider>
      </WalletProvider>
    </SharedConnectionContext.Provider>
  );
}
