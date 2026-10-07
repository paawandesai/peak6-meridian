import { describe, expect, it } from "vitest";

import { DEFAULT_FEEDS_DIR } from "./cli";
import { toScaled18 } from "./decimal";
import { buildRequest, runJob, substitute, type HttpFetcher } from "./executor";
import { loadFeedDefinitions } from "./feeds";

const defs = loadFeedDefinitions(DEFAULT_FEEDS_DIR);
const tiingo = defs.find((d) => d.ticker === "AAPL" && d.source === "tiingo");
const twelve = defs.find((d) => d.ticker === "AAPL" && d.source === "twelvedata");
const tiingoJob = tiingo?.jobs[0];
const twelveJob = twelve?.jobs[0];
if (tiingoJob === undefined || twelveJob === undefined) throw new Error("AAPL definitions missing");

describe("substitute", () => {
  it("fills placeholders from the variables", () => {
    expect(substitute("Token ${K}", { K: "abc" })).toBe("Token abc");
    expect(substitute("no placeholders", {})).toBe("no placeholders");
  });

  it("fails on an unresolved or empty variable, like the oracles", () => {
    expect(() => substitute("Token ${K}", {})).toThrow(/unresolved variable \$\{K\}/);
    expect(() => substitute("Token ${K}", { K: "" })).toThrow(/unresolved/);
  });
});

describe("buildRequest", () => {
  it("puts the override in the Authorization header and leaves the URL untouched", () => {
    const request = buildRequest(tiingoJob.tasks[0].httpTask, { TIINGO_API_KEY: "k1" });
    expect(request.url).toBe("https://api.tiingo.com/tiingo/daily/aapl/prices");
    expect(request.headers["Authorization"]).toBe("Token k1");
  });

  it("cannot change the URL however the override is chosen (no query injection)", () => {
    const hostile = "x&startDate=2020-01-02&ticker=msft";
    const request = buildRequest(twelveJob.tasks[0].httpTask, { TWELVEDATA_API_KEY: hostile });
    expect(request.url).toBe("https://api.twelvedata.com/eod?symbol=AAPL&exchange=NASDAQ");
  });
});

describe("runJob", () => {
  const answer =
    (body: string): HttpFetcher =>
    () =>
      body;

  it("returns the parsed close scaled by 10^18", () => {
    const body = JSON.stringify([{ close: 254.43 }]);
    expect(runJob(tiingoJob, answer(body), { TIINGO_API_KEY: "k" })).toBe(toScaled18("254.43"));
    const td = JSON.stringify({ close: "254.43" });
    expect(runJob(twelveJob, answer(td), { TWELVEDATA_API_KEY: "k" })).toBe(toScaled18("254.43"));
  });

  it("fails on a non-JSON body", () => {
    expect(() => runJob(tiingoJob, answer("<html>"), { TIINGO_API_KEY: "k" })).toThrow(
      /api.tiingo.com is not JSON/,
    );
  });

  it("fails rather than reading zero when the value is missing or not numeric", () => {
    const vars = { TIINGO_API_KEY: "k" };
    expect(() => runJob(tiingoJob, answer("[]"), vars)).toThrow(/no numeric value/);
    expect(() => runJob(tiingoJob, answer('[{"close":null}]'), vars)).toThrow(/no numeric value/);
    expect(() => runJob(tiingoJob, answer('[{"close":"n/a"}]'), vars)).toThrow(/not a decimal/);
  });

  it("fails without the key", () => {
    expect(() => runJob(tiingoJob, answer("[]"), {})).toThrow(/unresolved variable/);
  });
});
