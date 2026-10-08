/**
 * GET /api/fair-values (M3-03): proxies the quant service's `GET /fair-values` to the app. The
 * bearer token is added here, on the server, from `SERVICE_TOKEN`; it never reaches the browser
 * and is never echoed. The reply is validated and only the documented fields are returned.
 */
import { NextResponse } from "next/server";

import { fairValuesSchema } from "@/lib/fair-values";

export const dynamic = "force-dynamic";

/** Upstream deadline: the page polls every 5 s, so a slow service must not pile up requests. */
const TIMEOUT_MS = 4_000;

const headers = { "Cache-Control": "no-store" } as const;

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

function serviceUrl(raw: string | undefined): URL | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  const base = serviceUrl(process.env.QUANT_URL);
  const token = process.env.SERVICE_TOKEN;
  if (base === null || token === undefined || token === "") {
    return fail(503, "the quant service is not configured");
  }
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/fair-values", base), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    console.warn(JSON.stringify({ event: "fair_values_unreachable" }));
    return fail(502, "the quant service could not be reached");
  }
  if (!upstream.ok) {
    console.warn(JSON.stringify({ event: "fair_values_status", status: upstream.status }));
    return fail(502, `the quant service answered ${upstream.status}`);
  }
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return fail(502, "the quant service returned something that is not JSON");
  }
  const parsed = fairValuesSchema.safeParse(body);
  if (!parsed.success) {
    console.warn(JSON.stringify({ event: "fair_values_shape" }));
    return fail(502, "the quant service returned fair values in an unexpected shape");
  }
  return NextResponse.json(parsed.data, { headers });
}
