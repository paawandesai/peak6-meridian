import type { ReactNode } from "react";

/**
 * The sentence above the sign button (NFR-12, NFR-15). It renders what it is given and computes
 * nothing: the caller builds the sentence from integer units, with money from the display adapter.
 */
export function PayoffSentence({ children }: { readonly children: ReactNode }) {
  return <p className="text-mer-md text-mer-ink">{children}</p>;
}
