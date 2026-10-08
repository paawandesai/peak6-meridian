"use client";

import { MarketsView } from "./markets-view";
import { Providers } from "./providers";
import { UsdcBalance } from "./usdc-balance";
import { WalletButton } from "./wallet-button";

export function AppShell() {
  return (
    <Providers>
      <header className="flex items-center justify-between border-b border-slate-200 px-6 py-3">
        <h1 className="text-xl font-bold">Meridian</h1>
        <div className="flex items-center gap-4 text-sm">
          <UsdcBalance />
          <WalletButton />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-6">
        <h2 className="sr-only">Markets</h2>
        <MarketsView />
      </main>
    </Providers>
  );
}
