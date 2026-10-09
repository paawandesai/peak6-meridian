"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { DEMO_WALLET_NAME } from "@/lib/demo-wallet";

export function DemoWalletBanner() {
  const { wallet } = useWallet();

  if (wallet?.adapter.name !== DEMO_WALLET_NAME) return null;

  return (
    <div
      className="bg-orange-100 border-b border-orange-300 px-4 py-2 text-center text-sm text-orange-900"
      role="alert"
    >
      <strong>Demo wallet</strong> · devnet only · not a real wallet
    </div>
  );
}
