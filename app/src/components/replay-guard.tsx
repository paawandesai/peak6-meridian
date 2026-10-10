import type { ReactNode } from "react";

export const REPLAY_READ_ONLY_NOTE =
  "Replay is read-only: trading is off. The book and prices below are this market's current " +
  "on-chain state, not its state at the replay time (that is not stored on-chain).";

/**
 * Wraps the Trade page body. Live: a plain grid, exactly as before. Replay: a disabled
 * `<fieldset>`, which disables every button, input and select inside it natively (no change to
 * the trade components), plus a note saying what the page is showing.
 */
export function ReplayGuard({
  active,
  children,
}: {
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  if (!active) return <div className="grid gap-mer-8">{children}</div>;
  return (
    <fieldset
      disabled
      aria-label="Trading disabled in replay"
      data-testid="replay-guard"
      className="m-0 grid min-w-0 gap-mer-8 border-0 p-0"
    >
      <p
        role="note"
        className="rounded-mer border-2 border-mer-ink px-mer-3 py-mer-2 text-mer-sm font-semibold"
      >
        {REPLAY_READ_ONLY_NOTE}
      </p>
      {children}
    </fieldset>
  );
}
