import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assertHashesMatchDefinitions, parseFeedsFile, SOURCE_ORDER } from "../lib/feeds-file";
import { buildFeedsFixture, FEEDS_FIXTURE_PATH } from "./feeds-fixture";

describe("tests/fixtures/deploy/feeds.fixture.json", () => {
  const text = readFileSync(FEEDS_FIXTURE_PATH, "utf8");

  it("is exactly what the generator produces (regenerate with tsx test-support/feeds-fixture.ts)", () => {
    expect(JSON.parse(text)).toEqual(buildFeedsFixture());
  });

  it("parses as a --feeds file and its hashes match oracle/feeds/*", () => {
    const feeds = parseFeedsFile(text, "fixture");
    const generated = buildFeedsFixture();
    expect(() =>
      assertHashesMatchDefinitions(feeds, (ticker, index) => {
        const hash = generated[ticker]?.[index]?.hash;
        if (hash === undefined) throw new Error(`no ${ticker}.${SOURCE_ORDER[index]}`);
        return hash;
      }),
    ).not.toThrow();
  });
});
