// AB-13 · One data source returns a wrong close (bug, outage, manipulation); M2-02 AC4. The
// on-chain half (`settle_market` rejects a spread above `max_conf_bps` = 0.05% with
// `OracleSpreadTooWide`) is tested in programs/meridian/tests/settlement.rs. This is the
// operational half: `check-feeds.ts` must FAIL (non-zero exit, naming the ticker) when the two
// sources' simulated values differ by more than 0.05%, so a bad feed is caught before a market
// closes. Recorded values on both sides of the threshold; no network, no keys.
//
// The scripts are imported by path: switchboard-scripts only exports its library surface.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseFeedsFile as deployParseFeedsFile } from "../../../scripts/deploy/src/lib/feeds-file";
import {
  checkFeedsMain,
  DEFAULT_FIXTURE,
  EXIT_FAILED,
  EXIT_OK,
  type Io,
  type LiveDeps,
} from "../../../scripts/switchboard/src/cli";
import { SOURCES, TICKERS } from "../../../scripts/switchboard/src/feeds";
import { feedsFileJson } from "../../../scripts/switchboard/src/feedsFile";
import { Keypair } from "@solana/web3.js";

const TWELVE_DATA_URL = (ticker: string) =>
  `https://api.twelvedata.com/eod?symbol=${ticker}&exchange=NASDAQ`;
const TIINGO_URL = (ticker: string) =>
  `https://api.tiingo.com/tiingo/daily/${ticker.toLowerCase()}/prices`;

interface Recorded {
  responses: Record<string, unknown>;
}

/** The recorded fixture with one ticker's Twelve Data close moved by `deltaCents`. */
function fixtureWithSpread(
  ticker: string,
  deltaCents: number,
): { path: string; tiingoCents: number } {
  const fixture = JSON.parse(readFileSync(DEFAULT_FIXTURE, "utf8")) as Recorded;
  const tiingo = (fixture.responses[TIINGO_URL(ticker)] as { close: number }[])[0];
  const twelve = fixture.responses[TWELVE_DATA_URL(ticker)] as { close: string };
  if (tiingo === undefined) throw new Error(`no recorded Tiingo bar for ${ticker}`);
  const tiingoCents = Math.round(tiingo.close * 100);
  twelve.close = ((tiingoCents + deltaCents) / 100).toFixed(2);
  const path = join(mkdtempSync(join(tmpdir(), "ab13-")), "fixture.json");
  writeFileSync(path, JSON.stringify(fixture));
  return { path, tiingoCents };
}

function run(fixturePath: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = { out: (t) => stdout.push(t), err: (t) => stderr.push(t) };
  const deps = {} as unknown as LiveDeps; // a dry run touches no live dependency
  return checkFeedsMain(["--dry-run", "--fixture", fixturePath], {}, io, deps).then((code) => ({
    code,
    stdout: stdout.join("\n"),
    stderr,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AB-13 check-feeds: a source that disagrees by more than 0.05% fails the check", () => {
  // 5 bps of the mean, in whole cents, for the recorded META close.
  const { tiingoCents } = fixtureWithSpread("META", 0);
  const tolerance = Math.floor((tiingoCents * 5) / 10_000);

  it("passes just inside the threshold, whichever source is higher", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in this test")));
    for (const delta of [0, tolerance - 1, -(tolerance - 1)]) {
      const result = await run(fixtureWithSpread("META", delta).path);
      expect(result.code, `delta ${String(delta)}`).toBe(EXIT_OK);
      expect(result.stderr).toEqual([]);
    }
  });

  it("fails just outside the threshold, in either direction, naming the ticker", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in this test")));
    for (const delta of [tolerance + 3, -(tolerance + 3)]) {
      const result = await run(fixtureWithSpread("META", delta).path);
      expect(result.code, `delta ${String(delta)}`).toBe(EXIT_FAILED);
      expect(result.stderr).toHaveLength(1);
      expect(result.stderr[0]).toMatch(
        /^FAIL META: the two sources differ by \d+\.\d+ bps of their mean \(max 5 bps = 0\.05%\)$/,
      );
      expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(false);
    }
  });

  it("names only the ticker that is off, whichever it is", async () => {
    for (const ticker of TICKERS) {
      const { path, tiingoCents: cents } = fixtureWithSpread(ticker, 0);
      const off = fixtureWithSpread(ticker, Math.floor((cents * 5) / 10_000) + 5).path;
      const result = await run(off);
      expect(result.code).toBe(EXIT_FAILED);
      expect(result.stderr.map((line) => line.split(":")[0])).toEqual([`FAIL ${ticker}`]);
      expect((await run(path)).code).toBe(EXIT_OK);
    }
  });
});

describe("AB-13 the feeds file create-feeds writes is the one deploy-devnet --feeds reads", () => {
  it("is accepted by the deploy script's parser, with Tiingo at index 0 and Twelve Data at 1", () => {
    const created = TICKERS.flatMap((ticker) =>
      SOURCES.map((source) => ({
        ticker,
        source,
        feed: Keypair.generate().publicKey.toBase58(),
        feedHash: "ab".repeat(32),
      })),
    );
    const parsed = deployParseFeedsFile(feedsFileJson(created));
    for (const ticker of TICKERS) {
      const [tiingo, twelve] = parsed.get(ticker) ?? [];
      expect(tiingo?.pubkey.toBase58()).toBe(
        created.find((c) => c.ticker === ticker && c.source === "tiingo")?.feed,
      );
      expect(twelve?.pubkey.toBase58()).toBe(
        created.find((c) => c.ticker === ticker && c.source === "twelvedata")?.feed,
      );
    }
  });
});
