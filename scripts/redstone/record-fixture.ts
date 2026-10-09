/**
 * M2-17: RedStone fixture recorder for CI tests.
 *
 * Fetches ONE past trading day's signed RedStone packages at close for all MAG7 tickers from
 * both gateways, verifies byte-identity, and saves them with official Tiingo/Twelve Data closes
 * (public values only) into tests/fixtures/redstone/<YYYY-MM-DD>/.
 *
 * Run by hand (not in tests): NO API KEYS, fetches from public historical endpoints only.
 *
 * Usage:
 *   pnpm exec tsx scripts/redstone/record-fixture.ts --date 2026-10-08
 *   pnpm exec tsx scripts/redstone/record-fixture.ts --date 2026-10-08 --tiingo-key <key> --twelvedata-key <key>
 *
 * The --tiingo-key and --twelvedata-key options are for recording official closes; without them,
 * the script records only RedStone packages.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DateTime } from "luxon";

const MAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;

const REDSTONE_GATEWAYS = [
  "https://oracle-gateway-1.a.redstone.finance",
  "https://oracle-gateway-2.a.redstone.finance",
] as const;

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

interface CliArgs {
  date: string;
  tiingoKey?: string;
  twelvedataKey?: string;
}

interface RedStonePackage {
  gateway: string;
  ticker: string;
  timestampMs: number;
  payloadHex: string;
}

interface OfficialClose {
  source: "tiingo" | "twelvedata";
  ticker: string;
  closeCents: number;
  raw: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let date: string | undefined;
  let tiingoKey: string | undefined;
  let twelvedataKey: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && i + 1 < args.length) {
      date = args[i + 1];
      i++;
    } else if (args[i] === "--tiingo-key" && i + 1 < args.length) {
      tiingoKey = args[i + 1];
      i++;
    } else if (args[i] === "--twelvedata-key" && i + 1 < args.length) {
      twelvedataKey = args[i + 1];
      i++;
    }
  }

  if (!date) {
    console.error("Usage: tsx scripts/redstone/record-fixture.ts --date YYYY-MM-DD");
    process.exit(1);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("Error: --date must be in YYYY-MM-DD format");
    process.exit(1);
  }

  return { date, tiingoKey, twelvedataKey };
}

async function fetchWithRetry(url: string, headers: Record<string, string> = {}): Promise<string> {
  let lastError: Error = new Error("No attempts made");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`  Retry ${attempt}/${MAX_RETRIES}: ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status >= 500) {
          throw new Error(`HTTP ${response.status}`);
        }
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new Error("Timeout");
      }
      if (lastError.message.startsWith("HTTP 5") || lastError.message === "Timeout") {
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

async function fetchRedStonePackage(
  gateway: string,
  ticker: string,
  closeTimeMs: number,
): Promise<RedStonePackage> {
  const url = `${gateway}/data-packages/historical/redstone-primary-prod/${closeTimeMs}?symbols=${ticker}`;

  console.log(`Fetching ${ticker} from ${gateway}...`);
  const body = await fetchWithRetry(url);

  const data = JSON.parse(body);
  if (!data || typeof data !== "object") {
    throw new Error(`Invalid RedStone response for ${ticker}`);
  }

  if (!data[ticker] || !Array.isArray(data[ticker]) || data[ticker].length === 0) {
    throw new Error(`No data for ${ticker} in RedStone response`);
  }

  const signedPackage = data[ticker][0];
  if (
    !signedPackage ||
    typeof signedPackage !== "object" ||
    !signedPackage.signature ||
    !signedPackage.dataPoints
  ) {
    throw new Error(`Invalid package structure for ${ticker}`);
  }

  const payloadHex = JSON.stringify(signedPackage);

  return {
    gateway,
    ticker,
    timestampMs: closeTimeMs,
    payloadHex,
  };
}

async function fetchOfficialClose(
  source: "tiingo" | "twelvedata",
  ticker: string,
  date: string,
  apiKey: string,
): Promise<OfficialClose> {
  let url: string;
  let headers: Record<string, string>;

  if (source === "tiingo") {
    url = `https://api.tiingo.com/tiingo/daily/${ticker}/prices?startDate=${date}&endDate=${date}`;
    headers = { Authorization: `Token ${apiKey}` };
  } else {
    url = `https://api.twelvedata.com/eod?symbol=${ticker}&date=${date}`;
    headers = { Authorization: `apikey ${apiKey}` };
  }

  console.log(`Fetching ${ticker} official close from ${source}...`);
  const body = await fetchWithRetry(url, headers);

  const data = JSON.parse(body);
  let closeValue: number;

  if (source === "tiingo") {
    if (!Array.isArray(data) || data.length === 0 || typeof data[0]?.close !== "number") {
      throw new Error(`Invalid ${source} response for ${ticker}`);
    }
    closeValue = data[0].close;
  } else {
    if (typeof data?.close !== "number") {
      throw new Error(`Invalid ${source} response for ${ticker}`);
    }
    closeValue = data.close;
  }

  const closeCents = Math.round(closeValue * 100);

  return {
    source,
    ticker,
    closeCents,
    raw: body.slice(0, 10_000),
  };
}

function marketCloseTimeMs(date: string): number {
  // US stock market close: 16:00 ET (America/New_York timezone)
  const closeTime = DateTime.fromISO(`${date}T16:00:00`, { zone: "America/New_York" });
  if (!closeTime.isValid) {
    throw new Error(`Invalid date: ${date} (${closeTime.invalidReason})`);
  }
  return closeTime.toMillis();
}

async function recordFixtures(args: CliArgs): Promise<void> {
  const closeTimeMs = marketCloseTimeMs(args.date);
  const fixtureDir = join(process.cwd(), "tests", "fixtures", "redstone", args.date);

  console.log(
    `Recording fixtures for ${args.date} (close: ${new Date(closeTimeMs).toISOString()})`,
  );
  console.log(`Output: ${fixtureDir}`);

  await mkdir(fixtureDir, { recursive: true });

  const packages: RedStonePackage[] = [];
  const officialCloses: OfficialClose[] = [];

  for (const ticker of MAG7_TICKERS) {
    console.log(`\n=== ${ticker} ===`);

    const gatewayPackages: RedStonePackage[] = [];
    for (const gateway of REDSTONE_GATEWAYS) {
      try {
        const pkg = await fetchRedStonePackage(gateway, ticker, closeTimeMs);
        gatewayPackages.push(pkg);
      } catch (error) {
        console.error(`  Failed to fetch ${ticker} from ${gateway}: ${error}`);
        throw error;
      }
    }

    if (gatewayPackages.length !== REDSTONE_GATEWAYS.length) {
      throw new Error(`Did not fetch ${ticker} from all gateways`);
    }

    const pkg1 = gatewayPackages[0];
    const pkg2 = gatewayPackages[1];
    if (!pkg1 || !pkg2) {
      throw new Error(`Missing packages for ${ticker}`);
    }
    if (pkg1.payloadHex !== pkg2.payloadHex) {
      console.error(`  Gateway packages for ${ticker} are NOT byte-identical!`);
      console.error(`  Gateway 1 length: ${pkg1.payloadHex.length}`);
      console.error(`  Gateway 2 length: ${pkg2.payloadHex.length}`);
      throw new Error(`Gateways disagree on ${ticker} package`);
    }

    console.log(`  ✓ Byte-identical across ${REDSTONE_GATEWAYS.length} gateways`);
    packages.push(pkg1);

    if (args.tiingoKey) {
      try {
        const tiingoClose = await fetchOfficialClose("tiingo", ticker, args.date, args.tiingoKey);
        officialCloses.push(tiingoClose);
        console.log(`  ✓ Tiingo close: ${tiingoClose.closeCents}¢`);
      } catch (error) {
        console.error(`  Failed to fetch ${ticker} from Tiingo: ${error}`);
      }
    }

    if (args.twelvedataKey) {
      try {
        const twelveClose = await fetchOfficialClose(
          "twelvedata",
          ticker,
          args.date,
          args.twelvedataKey,
        );
        officialCloses.push(twelveClose);
        console.log(`  ✓ Twelve Data close: ${twelveClose.closeCents}¢`);
      } catch (error) {
        console.error(`  Failed to fetch ${ticker} from Twelve Data: ${error}`);
      }
    }
  }

  console.log(`\n=== Writing fixtures ===`);

  for (const pkg of packages) {
    const filename = `${pkg.ticker}.json`;
    await writeFile(join(fixtureDir, filename), pkg.payloadHex, "utf-8");
    console.log(`  Wrote ${filename}`);
  }

  if (officialCloses.length > 0) {
    const closesFilename = "official-closes.json";
    await writeFile(
      join(fixtureDir, closesFilename),
      JSON.stringify(officialCloses, null, 2),
      "utf-8",
    );
    console.log(`  Wrote ${closesFilename}`);
  }

  const signerAddresses: string[] = [];
  const firstPackage = packages[0];
  if (firstPackage) {
    const data = JSON.parse(firstPackage.payloadHex);
    if (data.signature && typeof data.signature === "string") {
      signerAddresses.push(`0x${data.signature.slice(0, 40)}`);
    }
  }

  const readme = `# RedStone Fixtures: ${args.date}

**Recorded:** ${new Date().toISOString()}
**Close time:** ${new Date(closeTimeMs).toISOString()} (4:00 PM ET)
**Tickers:** ${MAG7_TICKERS.join(", ")}
**Gateways:** ${REDSTONE_GATEWAYS.length} (byte-identical verified)

## Files

${packages.map((pkg) => `- \`${pkg.ticker}.json\`: RedStone signed package for ${pkg.ticker}`).join("\n")}
${officialCloses.length > 0 ? `- \`official-closes.json\`: Tiingo/Twelve Data official closes (public values only)` : ""}

## Provenance

- **Source:** RedStone Primary Prod (\`redstone-primary-prod\`)
- **Gateways:**
${REDSTONE_GATEWAYS.map((g, i) => `  ${i + 1}. ${g}`).join("\n")}
- **Timestamp:** ${closeTimeMs} (${new Date(closeTimeMs).toISOString()})
${signerAddresses.length > 0 ? `- **Signer addresses (sample):** ${signerAddresses.join(", ")}` : ""}

## Verification

All packages were verified byte-identical across ${REDSTONE_GATEWAYS.length} gateways.

## Usage

These fixtures are used by:
- \`programs/meridian/tests/redstone_fixture.rs\`: Signature verification with threshold 3
- \`tests/security/ts/ab_03_stale_or_wrong_date.test.ts\`: Stale package rejection
- \`tests/security/ts/ab_04_spoofed_feed.test.ts\`: Tampered/spoofed package rejection
- \`tests/security/ts/ab_05_settle_before_close.test.ts\`: Settlement timing
- \`tests/security/ts/ab_13_feed_spread.test.ts\`: Oracle vs official close spread check

Public data only (no API keys, no secrets).
`;

  await writeFile(join(fixtureDir, "README.md"), readme, "utf-8");
  console.log(`  Wrote README.md`);

  console.log(`\n✓ Recorded ${packages.length} fixtures to ${fixtureDir}`);
}

recordFixtures(parseArgs()).catch((error) => {
  console.error("\nError:", error);
  process.exit(1);
});
