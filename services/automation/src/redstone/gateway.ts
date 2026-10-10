/**
 * RedStone gateway client (M2-16 AC1)
 * Fetches packages from >=2 gateways, validates byte-identical responses
 */

import { z } from "zod";

import type { RedstoneGatewayConfig, RedstoneHistoricalResponse } from "./types.js";

/** RedStone historical response schema (validated against gateway API) */
const RedstoneHistoricalSchema = z.object({
  id: z.string(),
  timestampMilliseconds: z.number(),
  payload: z.string().regex(/^0x[0-9a-fA-F]+$/, "payload must be hex-encoded"),
});

/**
 * Fetch RedStone historical package from gateway with timeout.
 */
async function fetchFromGateway(
  gateway: string,
  dataServiceId: string,
  symbol: string,
  timestampMs: number,
  timeoutMs: number,
): Promise<RedstoneHistoricalResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // RedStone gateway historical endpoint format:
    // GET /data-packages/historical/{dataServiceId}/{timestamp}?symbols={symbol}
    const url = `${gateway}/data-packages/historical/${dataServiceId}/${timestampMs}?symbols=${symbol}`;
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`Gateway ${gateway} returned HTTP ${res.status}`);
    }

    const json = await res.json();

    // Gateway returns array of packages; we requested one symbol
    const packages = Array.isArray(json) ? json : [json];
    if (packages.length === 0) {
      throw new Error(`Gateway ${gateway} returned no packages for ${symbol}`);
    }

    // Validate with zod
    const result = RedstoneHistoricalSchema.safeParse(packages[0]);
    if (!result.success) {
      throw new Error(`Gateway ${gateway} response schema invalid: ${result.error.message}`);
    }

    return result.data;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch from >=2 gateways and verify byte-identical payloads (M2-16 AC1).
 * Returns the validated payload bytes.
 */
export async function fetchRedstonePackages(
  config: RedstoneGatewayConfig,
  symbol: string,
  closeTimestampMs: number,
): Promise<Uint8Array> {
  if (config.gateways.length < 2) {
    throw new Error("RedStone requires at least 2 gateways");
  }

  const responses: RedstoneHistoricalResponse[] = [];
  const errors: string[] = [];

  // Fetch from all gateways
  for (const gateway of config.gateways) {
    try {
      const pkg = await fetchFromGateway(
        gateway,
        config.dataServiceId,
        symbol,
        closeTimestampMs,
        config.timeoutMs,
      );
      responses.push(pkg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${gateway}: ${msg}`);
    }
  }

  if (responses.length < 2) {
    throw new Error(
      `Only ${responses.length}/${config.gateways.length} gateway(s) responded (need >=2). ` +
      `Errors: ${errors.join("; ")}`,
    );
  }

  // Verify byte-identical payloads across all responses
  const first = responses[0];
  if (first === undefined) {
    throw new Error("No responses received from gateways");
  }

  const firstPayload = first.payload;
  for (let i = 1; i < responses.length; i++) {
    const resp = responses[i];
    if (resp === undefined) continue;
    if (resp.payload !== firstPayload) {
      throw new Error(
        `Gateway payload mismatch: gateway[0] and gateway[${i}] returned different payloads`,
      );
    }
  }

  // Verify all timestamps match
  const firstTimestamp = first.timestampMilliseconds;
  for (let i = 1; i < responses.length; i++) {
    const resp = responses[i];
    if (resp === undefined) continue;
    if (resp.timestampMilliseconds !== firstTimestamp) {
      throw new Error(
        `Gateway timestamp mismatch: expected ${firstTimestamp}, ` +
        `gateway[${i}] returned ${resp.timestampMilliseconds}`,
      );
    }
  }

  // Convert hex payload to bytes
  const hexPayload = firstPayload.startsWith("0x") ? firstPayload.slice(2) : firstPayload;
  const payloadBytes = new Uint8Array(hexPayload.length / 2);
  for (let i = 0; i < payloadBytes.length; i++) {
    payloadBytes[i] = parseInt(hexPayload.slice(i * 2, i * 2 + 2), 16);
  }

  return payloadBytes;
}
