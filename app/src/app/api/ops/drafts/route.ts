/**
 * GET /api/ops/drafts (M3-06): proxies the ops-agent's override drafts to the admin page. The
 * bearer token is added here, on the server, from `SERVICE_TOKEN`; it never reaches the browser
 * and is never echoed. The upstream reply is validated and only the documented fields are
 * returned, so a malformed or hostile reply cannot reach the page. This route only reads: nothing
 * is signed or settled here (AB-07); the admin approves in their own wallet.
 */
import { NextResponse } from "next/server";

import { draftsSchema } from "@/components/admin-override/drafts";

export const dynamic = "force-dynamic";

/** Upstream deadline; the admin page polls, so a slow agent must not hang a request. */
const TIMEOUT_MS = 5_000;

const headers = { "Cache-Control": "no-store" } as const;

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

function agentUrl(raw: string | undefined): URL | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  const base = agentUrl(process.env.OPS_AGENT_URL);
  const token = process.env.SERVICE_TOKEN;
  if (base === null || token === undefined || token === "") {
    return fail(503, "the ops agent is not configured");
  }
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/drafts", base), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    console.warn(JSON.stringify({ event: "ops_drafts_unreachable" }));
    return fail(502, "the ops agent could not be reached");
  }
  if (!upstream.ok) {
    console.warn(JSON.stringify({ event: "ops_drafts_status", status: upstream.status }));
    return fail(502, `the ops agent answered ${upstream.status}`);
  }
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return fail(502, "the ops agent returned something that is not JSON");
  }
  const parsed = draftsSchema.safeParse(body);
  if (!parsed.success) {
    console.warn(JSON.stringify({ event: "ops_drafts_shape" }));
    return fail(502, "the ops agent returned drafts in an unexpected shape");
  }
  return NextResponse.json(parsed.data, { headers });
}
