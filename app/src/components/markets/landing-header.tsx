"use client";

import { type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

type Props = {
  /** Demo wallet CTA button (provided by DemoWalletCTA in !125). */
  readonly demoWalletButton?: ReactNode;
};

const CONNECT_COPY =
  "Connecting costs nothing and moves no funds; each trade asks for one signature.";

/**
 * Landing header (FR-21) for first-time visitors on Markets page.
 * - Short explanation of how Meridian works
 * - Connect CTA with design.md copy
 * - Demo wallet button (slot)
 * - Hidden once wallet is connected (UI-03 AC7)
 */
export function LandingHeader({ demoWalletButton }: Props) {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();

  // Hide when wallet is connected (FR-21, UI-03 AC7)
  if (publicKey !== null) {
    return null;
  }

  return (
    <div className="border-b border-mer-rule bg-mer-surface px-mer-4 py-mer-3">
      <div className="flex items-start justify-between gap-mer-3">
        <div className="flex-1 space-y-mer-2">
          <p className="text-mer-sm text-mer-ink">
            Will META close at or above $680 at today's 4:00 PM ET close? Buy YES or NO. The
            winning side pays $1.00 per contract; you know your max loss before you sign.
          </p>
          <div className="flex flex-wrap items-center gap-mer-2">
            <p className="text-mer-xs text-mer-ink-muted">
              Connecting asks for nothing and moves nothing. Each trade is one signature.
            </p>
            {demoWalletButton}
          </div>
        </div>
      </div>
    </div>
  );
}
