"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { type ReactNode, useMemo } from "react";

import { ReaderProvider } from "./reader-context";
import { createReader } from "@/lib/chain";
import { loadPublicConfig } from "@/lib/config";

/** Wallet adapters (Phantom, Solflare) plus the read-only chain reader. */
export function Providers({ children }: { readonly children: ReactNode }) {
  const config = useMemo(() => loadPublicConfig(), []);
  const reader = useMemo(() => createReader(config), [config]);
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={config.rpcUrl}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <ReaderProvider reader={reader}>{children}</ReaderProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
