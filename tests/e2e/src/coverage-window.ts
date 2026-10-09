/**
 * `coverage-window` (M3-09): samples the share of the day's open strikes that have a two-sided
 * quote (a best bid and a best ask on the on-chain book) every 30 s for 30 min and writes the
 * summary. Read-only; it reads the books themselves, so it measures what traders see whether or
 * not the market-maker service reports its own `book_coverage`.
 *
 *   pnpm --filter e2e run coverage-window -- [--interval-secs 30] [--duration-secs 1800]
 *     [--date YYYYMMDD] [--out DIR] [--who NAME]
 *
 * Environment: SOLANA_CLUSTER (`devnet`, or `localnet` with a loopback URL), SOLANA_RPC_URL,
 * optional MERIDIAN_PROGRAM_ID. Writes `summary.json`, `samples.json` and `log-entry.md` (the
 * text for docs/log.md) to the output directory (default `target/friday`). Exit code 0 only when
 * the window passes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { bookAccountApi, fetchBookQuotes } from "@meridian/client";

import {
  collect,
  DEFAULT_DURATION_SECS,
  DEFAULT_INTERVAL_SECS,
  formatBps,
  renderLogEntry,
  type Sample,
  type StrikeSample,
  summarize,
} from "./coverage-window-core";
import { connectReadOnly, etTradingDate, isoDate, marketsOfDate } from "./friday-chain";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function whole(text: string | undefined, fallback: number, name: string): number {
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text)) throw new Error(`--${name} must be a whole number`);
  return Number(text);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      "interval-secs": { type: "string" },
      "duration-secs": { type: "string" },
      date: { type: "string" },
      out: { type: "string" },
      who: { type: "string" },
    },
    strict: true,
  });
  const intervalSecs = whole(values["interval-secs"], DEFAULT_INTERVAL_SECS, "interval-secs");
  const durationSecs = whole(values["duration-secs"], DEFAULT_DURATION_SECS, "duration-secs");
  const chain = await connectReadOnly(process.env);
  const nowSecs = (): number => Math.floor(Date.now() / 1000);
  const date = values.date === undefined ? etTradingDate(nowSecs()) : whole(values.date, 0, "date");
  const books = bookAccountApi(chain.program);

  const sample = async (): Promise<StrikeSample[]> => {
    try {
      const now = nowSecs();
      const open = (await marketsOfDate(chain.program, date)).filter(
        (market) => !market.settled && now < market.closeTs,
      );
      const quotes = await fetchBookQuotes(
        books,
        open.map((m) => m.address),
        chain.programId,
      );
      return open.map((market) => ({
        market: market.address.toBase58(),
        label: market.label,
        quotes: quotes[market.address.toBase58()] ?? null,
      }));
    } catch (error) {
      throw chain.redact(error);
    }
  };

  const startedAt = nowSecs();
  console.log(
    `coverage window for ${isoDate(date)}: every ${intervalSecs} s for ${durationSecs} s on ${chain.cluster}`,
  );
  const samples: Sample[] = await collect({
    sample,
    now: nowSecs,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    intervalSecs,
    durationSecs,
    onSample: (s) => {
      console.log(
        s.ok
          ? `[${new Date(s.at * 1000).toISOString()}] ${s.strikes.length} open strikes`
          : `[${new Date(s.at * 1000).toISOString()}] read failed: ${s.error}`,
      );
    },
  });
  const summary = summarize(samples);
  const out = resolve(ROOT, values.out ?? "target/friday");
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, "samples.json"), `${JSON.stringify(samples, null, 2)}\n`);
  writeFileSync(resolve(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const etWindow = `${new Date(startedAt * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })}–${new Date(nowSecs() * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })}`;
  const entry = renderLogEntry(summary, {
    who: values.who ?? "unspecified",
    date: isoDate(date),
    etWindow,
    intervalSecs,
  });
  writeFileSync(resolve(out, "log-entry.md"), entry);
  console.log(entry);
  console.log(
    `pooled coverage ${summary.pooledBps === null ? "n/a" : formatBps(summary.pooledBps)}; files in ${out}`,
  );
  return summary.passes ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
