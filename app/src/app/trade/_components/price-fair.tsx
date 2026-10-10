import { complementCents } from "@meridian/client";

import { FairEdge } from "@/components/fair-value/fair-edge";
import type { FairValues } from "@/lib/fair-values";

export const NO_TIGHT_PRICE_TEXT = "YES price: none shown (one side empty or spread over 10¢)";
export const FAIR_UNAVAILABLE_TEXT =
  "Fair value unavailable: the pricing service has not published one for this strike.";

/**
 * The strike's displayed price with its fair value and edge beside it (US-15, FR-24; design.md
 * §3 "Price, probability, fair value, edge"): `YES 44¢ · 44% · NO 56¢` then `Fair 41¢ · Edge
 * +3¢ (rich)`. Rich/cheap/fair is always a word. A missing number is said in words, never made up.
 */
export function PriceFair({
  marketAddress,
  yesCents,
  fair,
  nowSecs,
}: {
  readonly marketAddress: string;
  /** The YES mid under the displayed-price rule, or `null`. */
  readonly yesCents: number | null;
  readonly fair: FairValues;
  readonly nowSecs: number;
}) {
  const value = fair.byMarket[marketAddress];
  return (
    <div className="flex flex-wrap items-baseline gap-x-mer-4 gap-y-mer-1" data-testid="price-fair">
      <p
        className={
          yesCents === null ? "text-mer-sm text-mer-ink-muted" : "mer-num text-mer-md font-semibold"
        }
        data-testid="displayed-price"
      >
        {yesCents === null
          ? NO_TIGHT_PRICE_TEXT
          : `YES ${yesCents}¢ · ${yesCents}% · NO ${complementCents(yesCents)}¢`}
      </p>
      {fair.status !== "loading" && value === undefined ? (
        <p className="text-mer-sm text-mer-ink-muted" data-testid="fair-edge-missing">
          {FAIR_UNAVAILABLE_TEXT}
        </p>
      ) : (
        <FairEdge
          yesCents={yesCents}
          fair={value}
          status={fair.status}
          refreshFailed={fair.refreshFailed}
          nowSecs={nowSecs}
        />
      )}
    </div>
  );
}
