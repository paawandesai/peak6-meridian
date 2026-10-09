/**
 * The position constraint (FR-18, US-07, domain.md § Position constraint): a wallet holding NO
 * cannot Buy YES, and one holding YES cannot Buy NO, until it exits. The UI shows the exit
 * action instead. Exception: a resting limit Buy NO, where the YES is in escrow on the book.
 */
import type { Intent } from "@meridian/client";

export type Holdings = {
  /** YES tokens in the wallet. */
  readonly yes: bigint;
  /** NO tokens in the wallet. */
  readonly no: bigint;
  /** The wallet has a resting YES ask on this book (a limit Buy NO waiting to fill). */
  readonly hasRestingAsk: boolean;
};

export type IntentGate =
  | { readonly blocked: false }
  | {
      readonly blocked: true;
      readonly kind: "hold-no" | "hold-yes" | "resting-buy-no";
      readonly text: string;
      /** The intent the notice's button preselects, or `null` (cancel the resting order instead). */
      readonly exit: Intent | null;
      readonly exitLabel: string | null;
      /** How many contracts the exit should be preselected with. */
      readonly exitQty: bigint;
    };

export const RESTING_BUY_NO_TEXT =
  "Your limit Buy NO is resting; you hold YES in escrow until it fills.";

const NOT_BLOCKED: IntentGate = { blocked: false };

export function gateFor(intent: Intent, holdings: Holdings): IntentGate {
  if (intent === "BUY_YES" && (holdings.no > 0n || holdings.hasRestingAsk)) {
    if (holdings.hasRestingAsk) {
      return {
        blocked: true,
        kind: "resting-buy-no",
        text: RESTING_BUY_NO_TEXT,
        exit: null,
        exitLabel: null,
        exitQty: 0n,
      };
    }
    return {
      blocked: true,
      kind: "hold-no",
      text: `You hold ${holdings.no} NO on this strike. Sell NO first to buy YES.`,
      exit: "SELL_NO",
      exitLabel: "Sell NO",
      exitQty: holdings.no,
    };
  }
  if (intent === "BUY_NO" && holdings.yes > 0n) {
    return {
      blocked: true,
      kind: "hold-yes",
      text: `You hold ${holdings.yes} YES on this strike. Sell YES first to buy NO.`,
      exit: "SELL_YES",
      exitLabel: "Sell YES",
      exitQty: holdings.yes,
    };
  }
  return NOT_BLOCKED;
}
