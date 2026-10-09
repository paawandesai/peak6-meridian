/**
 * The ops-agent draft contract (docs/architecture.md § Service HTTP contracts) as the app reads
 * it: `GET /drafts` → `[{incident_id, market, proposed_price_cents, sources[{name, close,
 * as_of}], spread_bps, note, status}]`. Used by the server proxy (to validate what the service
 * returned) and by the admin section (to validate what the proxy returned). Nothing here reads
 * the environment, so it is safe in the client bundle.
 */
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

const marketAddress = z.string().refine((value) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}, "not a base58 market address");

export const sourceSchema = z.object({
  name: z.string().min(1).max(64),
  /** Source close, integer cents. */
  close: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  as_of: z.iso.datetime({ offset: true }),
});

export const draftSchema = z.object({
  incident_id: z.string().min(1).max(128),
  market: marketAddress,
  /** The settle price in integer cents: passed to `admin_settle_override` unchanged. */
  proposed_price_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sources: z.array(sourceSchema).min(1).max(8),
  spread_bps: z.number().int().nonnegative().max(1_000_000),
  note: z.string().max(4_000),
  status: z.string().min(1).max(64),
});

export const draftsSchema = z.array(draftSchema).max(200);

export type Draft = z.infer<typeof draftSchema>;

/** Only a draft in this state may be approved; the service sets it (M3-05). */
export const PENDING_STATUS = "pending_approval";

export const DRAFTS_PATH = "/api/ops/drafts";

/** Reads the proxy; throws a plain-words error (never the response body) on any failure. */
export async function fetchDrafts(
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
): Promise<Draft[]> {
  const response = await fetcher(DRAFTS_PATH, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      response.status === 503
        ? "the ops agent is not configured for this app"
        : `the ops agent could not be reached (${response.status})`,
    );
  }
  const parsed = draftsSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("the ops agent returned drafts in an unexpected shape");
  return parsed.data;
}
