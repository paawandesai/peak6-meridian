import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Keypair, type Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FEEDS_DIR,
  DEFAULT_FIXTURE,
  EXIT_BLOCKED,
  EXIT_FAILED,
  EXIT_OK,
  REPO_ROOT,
  createFeedsMain,
  defaultLiveDeps,
  keyOverrides,
  spikeMain,
  type Io,
  type LiveDeps,
} from "./cli";
import { DEVNET_GENESIS_HASH, DEVNET_QUEUE, type SwitchboardClient } from "./devnet";
import { loadFeedDefinitions } from "./feeds";
import { computeFeedHash, type SpikeReport } from "./spike";
import { fakeClient } from "./test-fakes";

const TIINGO = "tiingo-live-value-xyz";
const TWELVE = "twelvedata-live-value-xyz";
const defs = loadFeedDefinitions(DEFAULT_FEEDS_DIR);

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (t) => stdout.push(t), err: (t) => stderr.push(t) };
}

/** Live deps with a fake RPC (given genesis) and a fake Switchboard client. */
function fakeDeps(client: SwitchboardClient, genesis = DEVNET_GENESIS_HASH): LiveDeps {
  const connection = { getGenesisHash: () => Promise.resolve(genesis) } as unknown as Connection;
  return {
    connect: () => connection,
    loadKeypair: () => Keypair.generate(),
    client: () => Promise.resolve(client),
  };
}

/** Feed accounts for every ticker, and a client whose on-chain hashes match the definitions. */
function liveFixture() {
  const accounts = new Map<string, string>();
  const feedsJson: Record<string, string[]> = {};
  for (const def of defs) {
    const pk = Keypair.generate().publicKey;
    accounts.set(pk.toBase58(), computeFeedHash(DEVNET_QUEUE, def));
    (feedsJson[def.ticker] ??= []).push(pk.toBase58());
  }
  const client = fakeClient({
    feedHashOf: (feed) => Promise.resolve(accounts.get(feed.toBase58()) ?? ""),
  });
  return { client, feedsJson: JSON.stringify(feedsJson) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spike --dry-run (AC2)", () => {
  it("runs offline against the fixtures and prints hash, value, slot and oracles per feed", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network used in dry-run")));
    vi.stubGlobal("fetch", fetchSpy);
    const io = capture();
    const code = await spikeMain(["--dry-run"], {}, io, fakeDeps(fakeClient(), "not-called"));
    expect(code).toBe(EXIT_OK);
    expect(fetchSpy).not.toHaveBeenCalled();
    const report = JSON.parse(io.stdout.join("\n")) as SpikeReport;
    expect(report.mode).toBe("dry-run");
    expect(report.ok).toBe(true);
    expect(report.feeds).toHaveLength(14);
    for (const feed of report.feeds) {
      expect(feed.feedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(feed.value).toMatch(/^\d+(\.\d+)?$/);
      expect(feed.slot).toBe(412345678);
      expect(feed.oracles.length).toBeGreaterThan(0);
    }
  });

  it("never needs or prints the real keys", async () => {
    const io = capture();
    const env = { TIINGO_API_KEY: TIINGO, TWELVEDATA_API_KEY: TWELVE };
    expect(await spikeMain(["--dry-run"], env, io)).toBe(EXIT_OK);
    const printed = [...io.stdout, ...io.stderr].join("\n");
    expect(printed.includes(TIINGO) || printed.includes(TWELVE)).toBe(false);
  });

  it("the spike.ts entry point runs in a subprocess with --dry-run", () => {
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", resolve(REPO_ROOT, "scripts/switchboard/spike.ts"), "--dry-run"],
      { cwd: REPO_ROOT, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } },
    );
    expect((JSON.parse(out) as SpikeReport).ok).toBe(true);
  });

  it("exits non-zero when the fixture sources disagree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spike-"));
    const path = join(dir, "fixture.json");
    const url = "https://api.twelvedata.com/eod?symbol=AAPL&exchange=NASDAQ";
    const base = JSON.parse(readFileSync(DEFAULT_FIXTURE, "utf8")) as {
      responses: Record<string, unknown>;
    };
    base.responses[url] = { close: "300.00" };
    writeFileSync(path, JSON.stringify(base));
    const io = capture();
    expect(await spikeMain(["--dry-run", "--fixture", path], {}, io)).toBe(EXIT_FAILED);
  });
});

describe("spike live mode (devnet only)", () => {
  it("is blocked without keys and says which ones (AC3)", async () => {
    const io = capture();
    expect(await spikeMain([], {}, io)).toBe(EXIT_BLOCKED);
    expect(io.stderr).toEqual(["blocked: needs keys (TIINGO_API_KEY, TWELVEDATA_API_KEY)"]);
  });

  it("treats the .env.example placeholders as missing keys", async () => {
    const io = capture();
    const env = { TIINGO_API_KEY: "test-tiingo-key", TWELVEDATA_API_KEY: TWELVE };
    expect(await spikeMain(["--cluster", "devnet"], env, io)).toBe(EXIT_BLOCKED);
    expect(io.stderr).toEqual(["blocked: needs keys (TIINGO_API_KEY)"]);
  });

  it.each(["mainnet-beta", "mainnet", "localnet", "testnet"])(
    "refuses --cluster %s, even in dry-run",
    async (cluster) => {
      const io = capture();
      expect(await spikeMain(["--dry-run", "--cluster", cluster], {}, io)).toBe(EXIT_BLOCKED);
      expect(io.stderr.join()).toMatch(/devnet only/);
    },
  );

  it("refuses an RPC that is not devnet", async () => {
    const { client, feedsJson } = liveFixture();
    const env = {
      TIINGO_API_KEY: TIINGO,
      TWELVEDATA_API_KEY: TWELVE,
      SWITCHBOARD_FEEDS_JSON: feedsJson,
    };
    const io = capture();
    const code = await spikeMain([], env, io, fakeDeps(client, "mainnet-genesis"));
    expect(code).toBe(EXIT_FAILED);
    expect(io.stderr.join()).toMatch(/not Solana devnet/);
  });

  it("simulates every feed on devnet and prints no secrets", async () => {
    const { client, feedsJson } = liveFixture();
    const seen: Record<string, string>[] = [];
    const recording: SwitchboardClient = {
      ...client,
      fetchUpdate: (feed, overrides) => {
        seen.push(overrides);
        return client.fetchUpdate(feed, overrides);
      },
    };
    const env = {
      TIINGO_API_KEY: TIINGO,
      TWELVEDATA_API_KEY: TWELVE,
      SWITCHBOARD_FEEDS_JSON: feedsJson,
    };
    const io = capture();
    expect(await spikeMain(["--cluster", "devnet"], env, io, fakeDeps(recording))).toBe(EXIT_OK);
    const report = JSON.parse(io.stdout.join("\n")) as SpikeReport;
    expect(report.mode).toBe("devnet");
    expect(report.feeds.every((f) => f.feed !== null && f.slot === 99)).toBe(true);
    expect(seen).toHaveLength(14);
    expect(seen[0]).toEqual({ TIINGO_API_KEY: TIINGO, TWELVEDATA_API_KEY: TWELVE });
    const printed = [...io.stdout, ...io.stderr].join("\n");
    expect(printed.includes(TIINGO) || printed.includes(TWELVE)).toBe(false);
  });

  it("uses SWITCHBOARD_QUEUE when set", async () => {
    const queue = Keypair.generate().publicKey.toBase58();
    const io = capture();
    expect(await createFeedsMain(["--dry-run"], { SWITCHBOARD_QUEUE: queue }, io)).toBe(EXIT_OK);
    expect((JSON.parse(io.stdout.join("")) as { queue: string }).queue).toBe(queue);
  });
});

describe("create-feeds", () => {
  it("--dry-run prints the 14 feed hashes without touching the network", async () => {
    const io = capture();
    expect(await createFeedsMain(["--dry-run"], {}, io, fakeDeps(fakeClient(), "x"))).toBe(EXIT_OK);
    const out = JSON.parse(io.stdout.join("")) as { feeds: { feedHash: string }[] };
    expect(out.feeds.map((f) => f.feedHash)).toEqual(
      defs.map((d) => computeFeedHash(DEVNET_QUEUE, d)),
    );
  });

  it("creates the feeds on devnet and prints SWITCHBOARD_FEEDS_JSON", async () => {
    const hashes = new Map(defs.map((d) => [JSON.stringify(d.jobs[0]?.tasks[0]), d]));
    const client = fakeClient({
      storeJobs: (_, jobs) => {
        const def = hashes.get(JSON.stringify(jobs[0]?.toJSON().tasks?.[0]));
        return Promise.resolve(def === undefined ? "" : computeFeedHash(DEVNET_QUEUE, def));
      },
    });
    const io = capture();
    expect(await createFeedsMain(["--cluster", "devnet"], {}, io, fakeDeps(client))).toBe(EXIT_OK);
    expect(io.stdout[1]).toMatch(/^SWITCHBOARD_FEEDS_JSON=\{"AAPL":\["\w+","\w+"\]/);
  });

  it("reports a usage error for unknown flags", async () => {
    const io = capture();
    expect(await createFeedsMain(["--nope"], {}, io)).toBe(EXIT_FAILED);
    expect(io.stderr.join()).toMatch(/nope/);
  });
});

describe("keyOverrides", () => {
  it("returns exactly the two source keys, trimmed", () => {
    expect(keyOverrides({ TIINGO_API_KEY: " a ", TWELVEDATA_API_KEY: "b", OTHER: "c" })).toEqual({
      ok: true,
      overrides: { TIINGO_API_KEY: "a", TWELVEDATA_API_KEY: "b" },
    });
  });
});

describe("defaultLiveDeps.loadKeypair", () => {
  it("loads a keypair file and rejects anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    const kp = Keypair.generate();
    writeFileSync(join(dir, "id.json"), JSON.stringify(Array.from(kp.secretKey)));
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ not: "a keypair" }));
    expect(defaultLiveDeps.loadKeypair(join(dir, "id.json")).publicKey.equals(kp.publicKey)).toBe(
      true,
    );
    expect(() => defaultLiveDeps.loadKeypair(join(dir, "bad.json"))).toThrow(
      /not a Solana keypair/,
    );
  });

  it("connect builds a Connection without contacting it", () => {
    expect(defaultLiveDeps.connect("http://127.0.0.1:1").rpcEndpoint).toBe("http://127.0.0.1:1");
  });
});
