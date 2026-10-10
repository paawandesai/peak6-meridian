/**
 * What the Trade panel may do in each market state (design.md §3 "The four intents", "Market
 * state", "Precedence"). Pure: the clock is injected. The per-market state comes first
 * (Settled, Settlement delayed, Settling, Closed); `Paused` applies only to a market that would
 * otherwise be Open or Closing soon, and never removes cancel, withdraw or redeem.
 */
import { formatUsdCents, scaledToCentsFloor } from "@/lib/display";
import type { AppConfig } from "@/lib/chain";
import {
  marketStatus,
  SETTLEMENT_DELAYED_SECS,
  SETTLING_START_SECS,
  type MarketRow,
  type MarketStatus,
} from "@/lib/markets";
import { formatCountdown, formatEtHm } from "@/lib/time";
import type { StateBadgeProps } from "@/components/ui";

export const PAUSED_REASON =
  "Paused: trading and minting stopped; cancel, withdraw and redeem still work";
export const SETTLING_REASON = "Settling…";
/** Help text for Closed, Settling and Settlement delayed (design.md §3), its own element. */
export const CLOSED_HELP =
  "Trading has stopped. The result is set when settlement runs; closed does not mean settled.";

/** Which recovery actions the program still accepts in a state (the design.md §3 matrix). */
export type AllowedActions = {
  readonly cancel: boolean;
  readonly withdraw: boolean;
  readonly pairRedeem: boolean;
  readonly winnerRedeem: boolean;
};

export type PanelState =
  | {
      readonly tradable: true;
      readonly status: "Open" | "ClosingSoon";
      readonly allow: AllowedActions;
    }
  | {
      readonly tradable: false;
      readonly status: "Paused" | "Closed" | "Settling" | "SettlementDelayed" | "Settled";
      /** The one inline reason, exact strings from design.md §3. */
      readonly reason: string;
      /** The sibling help line for Closed, Settling and Settlement delayed. */
      readonly help?: string;
      readonly allow: AllowedActions;
    };

const RECOVERY: AllowedActions = {
  cancel: true,
  withdraw: true,
  pairRedeem: true,
  winnerRedeem: false,
};

/** `Settled YES at $181.42`: the settle price floored to a whole cent (never contradicts the outcome). */
export function settledText(market: MarketRow): string {
  const outcome = market.outcome === "Yes" ? "YES" : "NO";
  return `Settled ${outcome} at ${formatUsdCents(scaledToCentsFloor(market.settlePriceScaled))}`;
}

/** The override opens at `close_ts + override_delay_secs`; "at and after it" it is available now. */
export function overrideAvailableAt(market: MarketRow, config: AppConfig): bigint {
  return market.closeTs + config.overrideDelaySecs;
}

export function panelState(market: MarketRow, config: AppConfig, nowSecs: number): PanelState {
  const status: MarketStatus = marketStatus(market, nowSecs);
  const now = BigInt(nowSecs);
  switch (status) {
    case "Settled":
      return {
        tradable: false,
        status: "Settled",
        reason: settledText(market),
        allow: { cancel: true, withdraw: true, pairRedeem: false, winnerRedeem: true },
      };
    case "SettlementDelayed": {
      const at = overrideAvailableAt(market, config);
      const tail =
        now >= at
          ? "an admin override is available now"
          : `an admin override opens at ${formatEtHm(at)} ET`;
      return {
        tradable: false,
        status: "SettlementDelayed",
        reason: `Settlement delayed: automatic settlement has stopped; ${tail}`,
        help: CLOSED_HELP,
        allow: RECOVERY,
      };
    }
    case "Settling":
      return {
        tradable: false,
        status: "Settling",
        reason: SETTLING_REASON,
        help: CLOSED_HELP,
        allow: RECOVERY,
      };
    case "Closed":
      return {
        tradable: false,
        status: "Closed",
        reason: `Closed: no new orders; settling at ${formatEtHm(market.closeTs + SETTLING_START_SECS)} ET`,
        help: CLOSED_HELP,
        allow: RECOVERY,
      };
    case "Open":
    case "ClosingSoon":
      return config.paused
        ? { tradable: false, status: "Paused", reason: PAUSED_REASON, allow: RECOVERY }
        : { tradable: true, status, allow: RECOVERY };
  }
}

/** The badge for the same state, with the same precedence. */
export function badgeProps(market: MarketRow, config: AppConfig, nowSecs: number): StateBadgeProps {
  const status = marketStatus(market, nowSecs);
  const now = BigInt(nowSecs);
  switch (status) {
    case "Settled":
      return {
        state: "settled",
        outcome: market.outcome === "Yes" ? "YES" : "NO",
        price: formatUsdCents(scaledToCentsFloor(market.settlePriceScaled)),
      };
    case "SettlementDelayed": {
      const at = overrideAvailableAt(market, config);
      return { state: "settlement-delayed", overrideAt: now >= at ? "now" : formatEtHm(at) };
    }
    case "Settling":
      return { state: "settling" };
    case "Closed":
      return { state: "closed", settlingAt: formatEtHm(market.closeTs + SETTLING_START_SECS) };
    case "ClosingSoon":
      return config.paused
        ? { state: "paused" }
        : { state: "closing-soon", remaining: formatCountdown(Number(market.closeTs - now)) };
    case "Open":
      return config.paused ? { state: "paused" } : { state: "open" };
  }
}

export type NextTransition = { readonly label: string; readonly secondsLeft: number };

/** The countdown to the next state change (D-050), or `null` when nothing is left to wait for. */
export function nextTransition(
  market: MarketRow,
  config: AppConfig,
  nowSecs: number,
): NextTransition | null {
  const now = BigInt(nowSecs);
  const until = (label: string, at: bigint): NextTransition => ({
    label,
    secondsLeft: Number(at - now),
  });
  switch (marketStatus(market, nowSecs)) {
    case "Open":
    case "ClosingSoon":
      return until("Closes in", market.closeTs);
    case "Closed":
      return until("Settling starts in", market.closeTs + SETTLING_START_SECS);
    case "Settling":
      return until("Settlement delayed in", market.closeTs + SETTLEMENT_DELAYED_SECS);
    case "SettlementDelayed": {
      const at = overrideAvailableAt(market, config);
      return now >= at ? null : until("Admin override opens in", at);
    }
    case "Settled":
      return null;
  }
}
