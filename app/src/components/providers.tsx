"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { useStandardWalletAdapters } from "@solana/wallet-standard-wallet-adapter-react";
import { type ReactNode, useMemo } from "react";

import { BrowserMarketSources } from "./markets/data-context";
import { DemoWalletBanner } from "./DemoWalletBanner";
import { ReaderProvider } from "./reader-context";
import { TestMarketProvider } from "./test-market-context";
import { createReader } from "@/lib/chain";
import { loadPublicConfig } from "@/lib/config";
import { registerDemoWallet } from "@/lib/demo-wallet";
import { withRateLimitRetry } from "@/lib/rpc";

/** The wallet adapter's connection gets the same 429 backoff as the shared read connection. */
const WALLET_CONNECTION_CONFIG = {
  commitment: "confirmed" as const,
  disableRetryOnRateLimit: true,
  fetch: withRateLimitRetry((input, init) => fetch(input, init)),
};

if (typeof window !== "undefined") {
  registerDemoWallet();
}

/** Wallet adapters (Phantom, Solflare, demo wallet on devnet) plus the read-only chain reader. */
export function Providers({ children }: { readonly children: ReactNode }) {
  const config = useMemo(() => loadPublicConfig(), []);
  const reader = useMemo(() => createReader(config), [config]);
  const adapters = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  const wallets = useStandardWalletAdapters(adapters);
  return (
    <ConnectionProvider endpoint={config.rpcUrl} config={WALLET_CONNECTION_CONFIG}>
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
    </ConnectionProvider>
  );
}
