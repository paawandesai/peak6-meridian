import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_FEEDS_DIR, DEFAULT_FIXTURE } from "./cli";
import { buildRequest } from "./executor";
import { loadFeedDefinitions } from "./feeds";
import {
  DRY_RUN_VARIABLES,
  fixtureFetcher,
  fixtureSimulator,
  loadFixture,
  type SpikeFixture,
} from "./fixtures";

const fixture = loadFixture(DEFAULT_FIXTURE);
const defs = loadFeedDefinitions(DEFAULT_FEEDS_DIR);

describe("spike fixture", () => {
  it("answers every feed definition's request", () => {
    const fetch = fixtureFetcher(fixture);
    for (const def of defs) {
      const job = def.jobs[0];
      if (job === undefined) throw new Error("no job");
      const [{ httpTask }] = job.tasks;
      expect(() => fetch(buildRequest(httpTask, DRY_RUN_VARIABLES))).not.toThrow();
    }
  });

  it("uses stand-in credentials only", () => {
    expect(Object.values(DRY_RUN_VARIABLES)).toEqual(["dry-run", "dry-run"]);
  });

  it("rejects a malformed fixture file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fixture-")), "bad.json");
    writeFileSync(path, JSON.stringify({ slot: -1, oracles: [], responses: {} }));
    expect(() => loadFixture(path)).toThrow(/bad.json/);
  });
});

describe("fixtureFetcher", () => {
  const fetch = fixtureFetcher(fixture);
  const url = "https://api.twelvedata.com/eod?symbol=AAPL&exchange=NASDAQ";

  it("answers 401 without credentials, like the APIs", () => {
    expect(() => fetch({ url, headers: {} })).toThrow(/HTTP 401/);
    expect(() => fetch({ url, headers: { Authorization: "apikey " } })).toThrow(/HTTP 401/);
  });

  it("answers 404 for an unknown URL", () => {
    expect(() =>
      fetch({
        url: "https://api.twelvedata.com/eod?symbol=IBM",
        headers: { Authorization: "a b" },
      }),
    ).toThrow(/HTTP 404/);
  });
});

describe("fixtureSimulator", () => {
  it("reports each fixture oracle's value at the fixture slot", async () => {
    const def = defs[0];
    if (def === undefined) throw new Error("no definitions");
    const update = await fixtureSimulator(fixture).simulate(def, "hash");
    expect(update.slot).toBe(fixture.slot);
    expect(update.feed).toBeNull();
    expect(update.oracles.map((o) => o.oracle)).toEqual(fixture.oracles);
    expect(update.oracles.every((o) => o.value === "254.43" && o.error === null)).toBe(true);
  });

  it("reports per-oracle errors instead of throwing", async () => {
    const empty: SpikeFixture = { ...fixture, responses: {} };
    const def = defs[0];
    if (def === undefined) throw new Error("no definitions");
    const update = await fixtureSimulator(empty).simulate(def, "hash");
    expect(update.oracles.every((o) => o.value === null && /HTTP 404/.test(o.error ?? ""))).toBe(
      true,
    );
  });
});
