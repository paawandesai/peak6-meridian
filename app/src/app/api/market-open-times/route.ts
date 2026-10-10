/**
 * GET /api/market-open-times (P1-4; D-050, OQ-14): proxies the automation service's
 * `GET /markets` creation-time index to the app. The bearer token is added here, on the server,
 * from `SERVICE_TOKEN`; it never reaches the browser and is never echoed. The reply is validated
 * and only the documented fields are returned. Any failure is an error status, so the UI shows
 * "Open time unavailable" and never a guessed time.
 */
import { NextResponse } from "next/server";

import { openTimesSchema } from "@/lib/open-times-core";

export const dynamic = "force-dynamic";

/** Upstream deadline: the service answers within 2.5 s even while it refreshes its index. */
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
  const base = serviceUrl(process.env.AUTOMATION_URL);
  const token = process.env.SERVICE_TOKEN;
  if (base === null || token === undefined || token === "") {
    return fail(503, "the automation service is not configured");
  }
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/markets", base), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    console.warn(JSON.stringify({ event: "open_times_unreachable" }));
    return fail(502, "the automation service could not be reached");
  }
  if (!upstream.ok) {
    console.warn(JSON.stringify({ event: "open_times_status", status: upstream.status }));
    return fail(502, `the automation service answered ${upstream.status}`);
  }
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return fail(502, "the automation service returned something that is not JSON");
  }
  const parsed = openTimesSchema.safeParse(body);
  if (!parsed.success) {
    console.warn(JSON.stringify({ event: "open_times_shape" }));
    return fail(502, "the automation service returned open times in an unexpected shape");
  }
  return NextResponse.json(parsed.data, { headers });
}
