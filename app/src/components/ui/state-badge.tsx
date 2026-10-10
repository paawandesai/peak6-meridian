import type { ReactNode } from "react";

/**
 * Market state badge (docs/design.md §3 "Market state"). Pure presentation: the caller derives
 * the state and passes already-formatted times and prices. The text always carries the state;
 * colour only reinforces it.
 */
export type StateBadgeProps =
  | { readonly state: "open"; readonly closesAt?: string }
  | { readonly state: "closing-soon"; readonly remaining: string }
  | { readonly state: "closed"; readonly settlingAt: string }
  | { readonly state: "settling"; readonly attempt?: number }
  | {
      readonly state: "settlement-delayed";
      /** `HH:mm` of the override time, or `"now"` once it is available. */
      readonly overrideAt: string | "now";
    }
  | { readonly state: "settled"; readonly outcome: "YES" | "NO"; readonly price: string }
  | { readonly state: "paused" };

/** An override draft exists (supplied by M2/M3 data; the app does not read it from chain). */
export type OverridePendingProp = { readonly availableAt: string | "now" };

export function stateBadgeText(
  props: StateBadgeProps,
  overridePending?: OverridePendingProp,
): string {
  if (overridePending !== undefined) {
    return overridePending.availableAt === "now"
      ? "Override pending, available now"
      : `Override pending, available at ${overridePending.availableAt} ET`;
  }
  switch (props.state) {
    case "open":
      return props.closesAt !== undefined ? `Open · closes ${props.closesAt} ET` : "Open";
    case "closing-soon":
      return `Closes in ${props.remaining}`;
    case "closed":
      return `Closed, settling at ${props.settlingAt} ET`;
    case "settling":
      return props.attempt === undefined ? "Settling…" : `Settling… (attempt ${props.attempt})`;
    case "settlement-delayed":
      return props.overrideAt === "now"
        ? "Settlement delayed: automatic settlement has stopped; an admin override is available now"
        : `Settlement delayed: automatic settlement has stopped; an admin override opens at ${props.overrideAt} ET`;
    case "settled":
      return `Settled ${props.outcome} at ${props.price}`;
    case "paused":
      return "Paused: trading and minting stopped; cancel, withdraw and redeem still work";
  }
}

const BASE =
  "inline-flex items-center gap-mer-1 rounded-mer px-mer-2 py-0.5 text-mer-xs font-medium";

function treatment(props: StateBadgeProps, overridePending: boolean): string {
  if (overridePending) return "border border-mer-warn text-mer-warn";
  switch (props.state) {
    case "open":
      return "border border-mer-control-border text-mer-ink";
    case "closing-soon":
      return "border border-mer-warn bg-mer-warn/10 text-mer-warn";
    case "closed":
    case "settling":
      return "bg-mer-rule/60 text-mer-ink-muted";
    case "settlement-delayed":
      return "border border-mer-warn text-mer-warn";
    case "settled":
      return props.outcome === "YES" ? "bg-mer-yes text-mer-on-yes" : "bg-mer-no text-mer-on-no";
    case "paused":
      return "border border-mer-loss text-mer-loss";
  }
}

export function StateBadge(
  props: StateBadgeProps & { readonly overridePending?: OverridePendingProp },
): ReactNode {
  const { overridePending, ...state } = props;
  const text = stateBadgeText(state as StateBadgeProps, overridePending);
  return (
    <span
      className={`${BASE} ${treatment(state as StateBadgeProps, overridePending !== undefined)}`}
      data-state={overridePending === undefined ? state.state : "override-pending"}
    >
      {state.state === "settling" && overridePending === undefined ? (
        <span aria-hidden="true" className="mer-spin">
          ◌
        </span>
      ) : null}
      {text}
    </span>
  );
}
