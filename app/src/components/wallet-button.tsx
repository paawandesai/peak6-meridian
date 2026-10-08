"use client";

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useEffect, useState } from "react";

/** Connect button; rendered after mount because the wallet list differs server vs browser. */
export function WalletButton() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <WalletMultiButton /> : <div className="h-12 w-40" />;
}
