/**
 * When an override may be approved and how its evidence is worded (UI-08 AC1, design.md §3
 * "Override time"). Pure: the clock is injected. The available-at time is
 * `close_ts + override_delay_secs` rendered in ET; it is never hardcoded.
 */
import type { Draft } from "./drafts";
import { formatUsdCents } from "@/lib/display";
import type { AppConfig } from "@/lib/chain";
import { formatCountdown, formatEtHm, formatEtHms } from "@/lib/time";
import type { MarketRow } from "@/lib/markets";

export type ApproveState =
  | { readonly enabled: true; readonly availability: string }
  | { readonly enabled: false; readonly availability: string; readonly reason: string };

/** `close_ts + override_delay_secs`: the first second the program accepts an override. */
export function availableAt(market: MarketRow, config: AppConfig): bigint {
  return market.closeTs + config.overrideDelaySecs;
}

/**
 * Approve is enabled at and after the available-at instant, for an unsettled market only. The
 * program re-checks both (and the admin signer); this only keeps a doomed signature from being
 * requested.
 */
export function approveState(
  market: MarketRow | undefined,
  config: AppConfig,
  nowSecs: number,
): ApproveState {
  if (market === undefined) {
    return {
      enabled: false,
      availability: "Unknown market",
      reason: "This draft names a market that does not exist on chain.",
    };
  }
  if (market.settled) {
    return {
      enabled: false,
      availability: "Already settled",
      reason: "This market is already settled; the outcome never changes.",
    };
  }
  const at = availableAt(market, config);
  const now = BigInt(nowSecs);
  if (now >= at) return { enabled: true, availability: "Override available now" };
  return {
    enabled: false,
    availability: `Override available at ${formatEtHm(at)} ET (in ${formatCountdown(Number(at - now))})`,
    reason: `Approve opens at ${formatEtHm(at)} ET, ${config.overrideDelaySecs.toString()} s after the close.`,
  };
}

/** `as of 16:01:12 ET, 3 min old` for a source close observed at `asOf`. */
export function sourceAge(asOf: string, nowSecs: number): string {
  const secs = Math.floor(Date.parse(asOf) / 1000);
  const age = Math.max(0, nowSecs - secs);
  const text =
    age < 60
      ? `${age} s old`
      : age < 3600
        ? `${Math.floor(age / 60)} min old`
        : `${Math.floor(age / 3600)} h old`;
  return `as of ${formatEtHms(secs)} ET, ${text}`;
}

/** `$181.42` for a source close or proposed price in integer cents. */
export function money(cents: number): string {
  return formatUsdCents(BigInt(cents));
}

/** `0.04%` from whole basis points (exact: 1 bp = 0.01%). */
export function bpsText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, "0");
  return `${bps} bps (${whole}.${frac}%)`;
}

/** The proposed price lies between the lowest and highest source close (sanity cue, not a gate). */
export function withinSourceRange(draft: Draft): boolean {
  const closes = draft.sources.map((source) => source.close);
  return (
    draft.proposed_price_cents >= Math.min(...closes) &&
    draft.proposed_price_cents <= Math.max(...closes)
  );
}
