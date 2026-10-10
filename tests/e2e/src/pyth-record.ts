/**
 * Records the update Pyth Lazer signed at a session's close, for the settlement fixtures:
 * `pnpm --filter e2e pyth-record <TICKER> <YYYY-MM-DD>` (PYTH_API_TOKEN from the repo-root .env).
 *
 * Calls the live Pyth API once; tests only ever read the recorded JSON. The file holds the
 * signed bytes exactly as served (hex) plus where they came from; the token is never written.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkSignedClose,
  closeTimeET,
  confidenceBps,
  fetchSignedPrice,
  PYTH_FEED_IDS,
  PYTH_LAZER_URL,
  priceCents,
} from "automation";
import { z } from "zod";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const OUT_DIR = resolve(ROOT, "programs/meridian/tests/fixtures/pyth");
/** Pyth Lazer's production signer (D-056). */
const PYTH_LAZER_SIGNER = "80efc1f480c5615af3fb673d42287e993da9fbc3506b6e41dfa32950820c2e6c";

const env = z
  .object({ PYTH_API_TOKEN: z.string().min(8), PYTH_LAZER_URL: z.url().default(PYTH_LAZER_URL) })
  .parse(process.env);
const [ticker = "", date = ""] = process.argv.slice(2);
const requestedFeed = PYTH_FEED_IDS[ticker];
if (requestedFeed === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  throw new Error("usage: pyth-record <AAPL|AMZN|GOOGL|META|MSFT|NVDA|TSLA> <YYYY-MM-DD>");
}
const feedId: number = requestedFeed;

async function main(): Promise<void> {
  const { closeTs } = closeTimeET(date);
  const timestampUs = BigInt(closeTs) * 1_000_000n;
  const update = await fetchSignedPrice({
    post: (url, init) => fetch(url, { method: "POST", ...init }),
    token: env.PYTH_API_TOKEN,
    baseUrl: env.PYTH_LAZER_URL,
    feedId,
    timestampUs,
  });
  const envelope = Buffer.alloc(102);
  envelope.writeUInt32LE(2_182_742_457, 0);
  Buffer.from(update.signature).copy(envelope, 4);
  Buffer.from(update.publicKey).copy(envelope, 68);
  envelope.writeUInt16LE(update.payload.length, 100);
  const solanaHex = Buffer.concat([envelope, update.payload]).toString("hex");
  const file = resolve(OUT_DIR, `lazer_${ticker.toLowerCase()}_close_${date}.json`);
  const record = {
    source: `POST ${env.PYTH_LAZER_URL}/v1/price (formats [solana], channel fixed_rate@200ms, properties price/exponent/confidence), recorded ${new Date().toISOString()}`,
    ticker,
    feedId,
    closeTs,
    requestedTimestampUs: timestampUs.toString(),
    timestampUs: update.parsed.timestampUs.toString(),
    price: update.parsed.price.toString(),
    exponent: update.parsed.exponent,
    confidence: update.parsed.confidence?.toString() ?? null,
    priceCents: priceCents(update.parsed).toString(),
    confidenceBps: confidenceBps(update.parsed),
    signer: PYTH_LAZER_SIGNER,
    solanaHex,
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  // The same rules settle_market applies, with the production signer and the default 5 bps;
  // recorded either way so a failing update can be inspected.
  let verdict = "passes the settle_market rules (5 bps, 30 s window)";
  try {
    checkSignedClose(update, {
      signer: Buffer.from(PYTH_LAZER_SIGNER, "hex"),
      feedId,
      closeTs,
      closeWindowSecs: 30,
      maxConfBps: 5,
      nowSecs: Math.floor(Date.now() / 1_000),
    });
  } catch (error) {
    verdict = `FAILS the settle_market rules: ${error instanceof Error ? error.message : String(error)}`;
  }
  console.log(verdict);
  console.log(
    `${file}: ${ticker} ${date} close $${(Number(record.priceCents) / 100).toFixed(2)}, confidence ${record.confidenceBps.toFixed(3)} bps`,
  );
}

main().catch((error: unknown) => {
  console.error(`pyth-record failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
