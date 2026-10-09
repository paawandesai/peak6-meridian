/**
 * RedStone gateway client (M2-16 AC1)
 * Fetches packages from >=2 gateways, validates byte-identical responses
 */

import type { RedstoneGatewayConfig, RedstoneDataPackage } from "./types.js";

/**
 * Fetch RedStone package from gateway with timeout
 */
async function fetchFromGateway(
  gateway: string,
  dataServiceId: string,
  symbol: string,
  timestampMs: number,
  timeoutMs: number,
): Promise<RedstoneDataPackage> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${gateway}/data-packages/historical/${dataServiceId}/${timestampMs}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Gateway ${gateway} returned ${res.status}`);

    const data = await res.json();
    // TODO: Parse and validate with zod
    return data as RedstoneDataPackage;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch from >=2 gateways and verify byte-identical packages (M2-16 AC1)
 */
export async function fetchRedstonePackages(
  config: RedstoneGatewayConfig,
  symbol: string,
  closeTimestampMs: number,
): Promise<{ packages: RedstoneDataPackage[]; payload: Uint8Array }> {
  if (config.gateways.length < 2) {
    throw new Error("RedStone requires at least 2 gateways");
  }

  const packages: RedstoneDataPackage[] = [];

  for (const gateway of config.gateways) {
    try {
      const pkg = await fetchFromGateway(
        gateway,
        config.dataServiceId,
        symbol,
        closeTimestampMs,
        config.timeoutMs,
      );
      packages.push(pkg);
    } catch (err) {
      console.warn(`Gateway ${gateway} failed:`, err);
    }
  }

  if (packages.length < 2) {
    throw new Error(`Only ${packages.length} gateway(s) responded (need >=2)`);
  }

  // Verify byte-identical packages
  // TODO: Implement byte comparison and signer validation

  // Build post_redstone_price payload
  const payload = new Uint8Array(0); // TODO: Build actual payload

  return { packages, payload };
}
