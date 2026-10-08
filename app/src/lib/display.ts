/**
 * The single import point for display-only money helpers (UI-02 AC6 / AC6b, OQ-15 (a) approved).
 * They live in `packages/client/src/units.ts` (with their fast-check tests); the app imports them
 * from here so every money string has one source and components never format money themselves.
 */
export {
  formatPriceTenths,
  formatUsdCents,
  formatUsdSigned,
  formatUsdcBalance,
  scaledToCentsFloor,
  type SignMode,
} from "@meridian/client";
