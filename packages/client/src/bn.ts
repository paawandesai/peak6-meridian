/**
 * Anchor's `BN`, importable under both bundlers and plain Node ESM. Node cannot see `BN` as a
 * named export of the CommonJS `@coral-xyz/anchor` (it is re-exported from `bn.js`), so under
 * Node it comes from the module's `default`; vitest and bundlers expose it directly.
 */
import * as anchor from "@coral-xyz/anchor";

type AnchorModule = typeof anchor;
const resolved: AnchorModule =
  (anchor as AnchorModule & { default?: AnchorModule }).default ?? anchor;

/** Big-number class used for every u64/i128 argument of the generated client. */
export const BN = resolved.BN;
export type BN = anchor.BN;
