import type { ReactNode } from "react";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

export const MIDPOINT_NOTE =
  "Prices are the midpoint of the best bid and ask, not a price you can trade at. Buying costs the ask; selling pays the bid.";
export const SETTLE_NOTE =
  "Trading has stopped. The result is set when settlement runs; closed does not mean settled.";
export const CONNECT_COPY =
  "Connecting costs nothing and moves no funds; each trade asks for one signature.";

/** Always-visible notes under the page header (never hover-only, so keyboard and 390 px users see them). */
export function PageNotes({ showSettleNote }: { readonly showSettleNote: boolean }): ReactNode {
  return (
    <div className="mb-mer-4 space-y-mer-1 text-mer-sm text-mer-ink-muted">
      <p>{MIDPOINT_NOTE}</p>
      {showSettleNote ? <p>{SETTLE_NOTE}</p> : null}
    </div>
  );
}

/** The landing section (FR-21): two lines and a connect CTA, hidden once a wallet is connected. */
export function Landing(): ReactNode {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  if (publicKey !== null) return null;
  return (
    <section aria-label="About Meridian" className="mb-mer-6 border-b border-mer-rule pb-mer-4">
      <p className="text-mer-md">
        Will a MAG7 stock close at or above a price today? Pick a strike; YES wins at or above, NO
        wins below. Max loss is what you pay.
      </p>
      <p className="mt-mer-1 text-mer-sm text-mer-ink-muted">{CONNECT_COPY}</p>
      <button
        type="button"
        onClick={() => setVisible(true)}
        className="mt-mer-3 rounded-mer border border-mer-control-border px-mer-3 py-mer-1 text-mer-sm font-medium"
      >
        Connect wallet
      </button>
    </section>
  );
}
