import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type DemoSession, demoSessionsSchema } from "@meridian/client";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./env";
import {
  assertCompatible,
  parseRegistry,
  serializeRegistry,
  upsertSession,
  withAsOfCloses,
} from "./registry";

const SUN: DemoSession = {
  tradingDate: "2026-10-11",
  asOf: "2026-10-09",
  closeTs: 1_791_763_200,
  createdAt: "2026-10-10T16:00:00.000Z",
  tickers: ["AAPL"],
  strikesByTicker: { AAPL: [33_000, 34_000] },
  asOfCloseCentsByTicker: {},
  prevCloseDate: "2026-10-08",
  prevCloseCentsByTicker: { AAPL: 34_058 },
};
const SAT: DemoSession = { ...SUN, tradingDate: "2026-10-10", closeTs: 1_791_676_800 };

describe("registry file", () => {
  it("round-trips through serializeRegistry/parseRegistry, sorted by trading date", () => {
    const text = serializeRegistry({ sessions: [SUN, SAT] });
    expect(parseRegistry(text, "r")).toEqual({ sessions: [SAT, SUN] });
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("treats a missing file as empty and refuses invalid content", () => {
    expect(parseRegistry(null, "r")).toEqual({ sessions: [] });
    expect(() => parseRegistry("{", "reg.json")).toThrow(/reg.json: not valid JSON/);
    expect(() => parseRegistry('{"sessions":[{"tradingDate":"x"}]}', "reg.json")).toThrow(
      /reg.json/,
    );
  });

  it("the committed deployments/demo-sessions.json parses with the shared schema", () => {
    const text = readFileSync(resolve(REPO_ROOT, "deployments/demo-sessions.json"), "utf8");
    expect(demoSessionsSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });
});

describe("assertCompatible", () => {
  const registry = { sessions: [SUN] };

  it("accepts a new date and the same session again", () => {
    expect(() => assertCompatible(registry, "2026-10-10", "2026-10-09", 1)).not.toThrow();
    expect(() => assertCompatible(registry, SUN.tradingDate, SUN.asOf, SUN.closeTs)).not.toThrow();
  });

  it("refuses another AS_OF or another close on a registered date", () => {
    expect(() => assertCompatible(registry, SUN.tradingDate, "2026-10-08", SUN.closeTs)).toThrow(
      /already a demo of 2026-10-09 closing Sun Oct 11 2026 8:00 PM ET/,
    );
    expect(() => assertCompatible(registry, SUN.tradingDate, SUN.asOf, SUN.closeTs + 60)).toThrow(
      /already a demo/,
    );
  });
});

describe("upsertSession", () => {
  it("adds a new session", () => {
    expect(upsertSession({ sessions: [SAT] }, SUN)).toEqual({ sessions: [SAT, SUN] });
  });

  it("merges a re-run: keeps createdAt, unions tickers and strikes, never drops a close", () => {
    const first = upsertSession(
      { sessions: [] },
      { ...SUN, asOfCloseCentsByTicker: { AAPL: 33_606 } },
    );
    const merged = upsertSession(first, {
      ...SUN,
      createdAt: "2026-10-10T18:00:00.000Z",
      tickers: ["MSFT"],
      strikesByTicker: { AAPL: [34_000, 35_000], MSFT: [52_000] },
      asOfCloseCentsByTicker: { MSFT: 53_499 },
      prevCloseCentsByTicker: { MSFT: 52_241 },
    });
    expect(merged.sessions).toHaveLength(1);
    expect(merged.sessions[0]).toEqual({
      ...SUN,
      tickers: ["AAPL", "MSFT"],
      strikesByTicker: { AAPL: [33_000, 34_000, 35_000], MSFT: [52_000] },
      asOfCloseCentsByTicker: { AAPL: 33_606, MSFT: 53_499 },
      prevCloseCentsByTicker: { AAPL: 34_058, MSFT: 52_241 },
    });
  });

  it("omits the audit closes when neither side has any", () => {
    const { prevCloseCentsByTicker, ...bare } = SUN;
    expect(prevCloseCentsByTicker).toBeDefined();
    const merged = upsertSession({ sessions: [bare] }, bare);
    expect(merged.sessions[0]).not.toHaveProperty("prevCloseCentsByTicker");
  });
});

describe("withAsOfCloses", () => {
  it("adds closes to the named session only", () => {
    const out = withAsOfCloses({ sessions: [SAT, SUN] }, "2026-10-11", { AAPL: 33_606 });
    expect(out.sessions[0]).toEqual(SAT);
    expect(out.sessions[1]?.asOfCloseCentsByTicker).toEqual({ AAPL: 33_606 });
  });
});
