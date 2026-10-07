import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_FEEDS_DIR } from "./cli";
import {
  SOURCES,
  SOURCE_KEY_VARIABLE,
  TICKERS,
  definitionProblems,
  feedFileName,
  loadFeedDefinitions,
  orderFeeds,
  parseFeedDefinition,
  placeholders,
  type FeedDefinition,
} from "./feeds";

const AAPL_TIINGO = readFileSync(join(DEFAULT_FEEDS_DIR, "AAPL.tiingo.json"), "utf8");

function aaplTiingo(): FeedDefinition {
  return parseFeedDefinition(AAPL_TIINGO, "AAPL.tiingo.json");
}

/** AAPL.tiingo.json with one edit applied to its parsed JSON. */
function edited(edit: (json: Record<string, unknown> & { jobs: { tasks: unknown[] }[] }) => void) {
  const json = JSON.parse(AAPL_TIINGO) as Record<string, unknown> & {
    jobs: { tasks: unknown[] }[];
  };
  edit(json);
  return JSON.stringify(json);
}

describe("feed definitions in oracle/feeds", () => {
  const defs = loadFeedDefinitions(DEFAULT_FEEDS_DIR);

  it("has exactly one definition per MAG7 ticker and source (14)", () => {
    expect(defs).toHaveLength(TICKERS.length * SOURCES.length);
    expect(defs.map((d) => feedFileName(d.ticker, d.source))).toEqual(
      TICKERS.flatMap((t) => SOURCES.map((s) => `${t}.${s}.json`)),
    );
  });

  it.each(defs.map((d) => [feedFileName(d.ticker, d.source), d] as const))(
    "%s is an HTTP + JSON-parse job for the official close with the key as a placeholder",
    (_, def) => {
      expect(definitionProblems(def, feedFileName(def.ticker, def.source))).toEqual([]);
      const job = def.jobs[0];
      if (job === undefined) throw new Error("no job");
      const [{ httpTask }, { jsonParseTask }] = job.tasks;
      expect(httpTask.url.startsWith("https://")).toBe(true);
      expect(jsonParseTask.path).toBe(def.source === "tiingo" ? "$[0].close" : "$.close");
      expect(placeholders(JSON.stringify(def))).toEqual([SOURCE_KEY_VARIABLE[def.source]]);
      expect(new TextEncoder().encode(def.name).length).toBeLessThanOrEqual(32);
    },
  );
});

describe("parseFeedDefinition rejects", () => {
  it("invalid JSON", () => {
    expect(() => parseFeedDefinition("{", "AAPL.tiingo.json")).toThrow(/invalid JSON/);
  });

  it("a file name that does not match the content", () => {
    expect(() => parseFeedDefinition(AAPL_TIINGO, "MSFT.tiingo.json")).toThrow(
      /file name should be AAPL.tiingo.json/,
    );
  });

  it("unknown fields (strict shape)", () => {
    const raw = edited((json) => {
      json["apiKey"] = "x";
    });
    expect(() => parseFeedDefinition(raw, "AAPL.tiingo.json")).toThrow(/apiKey/);
  });

  it("task types other than httpTask then jsonParseTask", () => {
    const raw = edited((json) => {
      json.jobs[0]?.tasks.push({ valueTask: { value: 1 } });
    });
    expect(() => parseFeedDefinition(raw, "AAPL.tiingo.json")).toThrow();
  });

  it("a ticker outside MAG7", () => {
    const raw = edited((json) => {
      json["ticker"] = "IBM";
    });
    expect(() => parseFeedDefinition(raw, "IBM.tiingo.json")).toThrow(/ticker/);
  });

  it("plain http", () => {
    const raw = edited((json) => {
      const task = json.jobs[0]?.tasks[0] as { httpTask: { url: string } };
      task.httpTask.url = "http://api.tiingo.com/tiingo/daily/aapl/prices";
    });
    expect(() => parseFeedDefinition(raw, "AAPL.tiingo.json")).toThrow(/url/);
  });
});

describe("definitionProblems", () => {
  const withHttp = (patch: (task: FeedDefinition["jobs"][0]["tasks"][0]["httpTask"]) => void) => {
    const def = structuredClone(aaplTiingo());
    const task = def.jobs[0]?.tasks[0];
    if (task !== undefined) patch(task.httpTask);
    return definitionProblems(def, "AAPL.tiingo.json");
  };

  it("flags a literal API key in the Authorization header", () => {
    const problems = withHttp((task) => {
      task.headers = [{ key: "Authorization", value: `Token ${"a1".repeat(20)}` }];
    });
    expect(problems.join()).toMatch(/placeholders must be exactly \[TIINGO_API_KEY\]/);
    expect(problems.join()).toMatch(/Authorization header/);
  });

  it("flags the key moved into the URL (requesters could inject query parameters)", () => {
    const problems = withHttp((task) => {
      task.url += "?token=${TIINGO_API_KEY}";
      task.headers = [];
    });
    expect(problems.join()).toMatch(/url must not contain placeholders/);
  });

  it("flags extra placeholders that would let a requester change the data", () => {
    const problems = withHttp((task) => {
      task.url = "https://api.tiingo.com/tiingo/daily/aapl/prices?startDate=${DATE}";
    });
    expect(problems.join()).toMatch(/found \[DATE, TIINGO_API_KEY\]/);
  });

  it("flags another source's host and a missing ticker", () => {
    const problems = withHttp((task) => {
      task.url = "https://api.twelvedata.com/eod?symbol=MSFT";
    });
    expect(problems.join()).toMatch(/host must be api.tiingo.com/);
    expect(problems.join()).toMatch(/must name ticker AAPL/);
  });
});

describe("loadFeedDefinitions", () => {
  it("fails loudly when a definition is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "feeds-"));
    writeFileSync(join(dir, "AAPL.tiingo.json"), AAPL_TIINGO);
    expect(() => loadFeedDefinitions(dir)).toThrow(/expected definitions/);
  });

  it("orders by ticker then source slot", () => {
    const defs = loadFeedDefinitions(DEFAULT_FEEDS_DIR);
    expect(orderFeeds([...defs].reverse())).toEqual(defs);
  });
});

describe("placeholders", () => {
  it("lists ${NAME} references in order", () => {
    expect(placeholders("a ${X} b ${Y_2} ${X}")).toEqual(["X", "Y_2", "X"]);
    expect(placeholders("$X {Y} ${}")).toEqual([]);
  });
});
