"use client";

import { useWallet } from "@solana/wallet-adapter-react";

import { useReader } from "./reader-context";
import { formatUsdcBalance } from "@/lib/display";
import { useAsync } from "./use-async";

/** Connected wallet's test-USDC balance; renders nothing until a wallet connects. */
export function UsdcBalance() {
  const { publicKey } = useWallet();
  const reader = useReader();
  const state = useAsync(
    () => (publicKey === null ? Promise.resolve(null) : reader.usdcBalance(publicKey)),
    [reader, publicKey],
  );

  if (publicKey === null) return null;
  if (state.status === "loading") return <span role="status">Loading balance…</span>;
  if (state.status === "error")
    return <span role="alert">Balance unavailable: {state.message}</span>;
  if (state.value === null) return <span>Test-USDC mint not configured</span>;
  return <span className="mer-num">{formatUsdcBalance(state.value)}</span>;
}
