import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OracleJob } from "@switchboard-xyz/common";
import { z } from "zod";

/** MAG7 (domain.md glossary). */
export const TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;
export type Ticker = (typeof TICKERS)[number];

/** Data sources in Config source-slot order: slot 0 = Tiingo, slot 1 = Twelve Data (D-033). */
export const SOURCES = ["tiingo", "twelvedata"] as const;
export type Source = (typeof SOURCES)[number];

/** The only `${NAME}` placeholder each source's job may contain, filled from `variableOverrides`. */
export const SOURCE_KEY_VARIABLE: Readonly<Record<Source, string>> = {
  tiingo: "TIINGO_API_KEY",
  twelvedata: "TWELVEDATA_API_KEY",
};

const SOURCE_HOST: Readonly<Record<Source, string>> = {
  tiingo: "api.tiingo.com",
  twelvedata: "api.twelvedata.com",
};

/** The Authorization header each source expects, with the key as a placeholder. */
const SOURCE_AUTH_HEADER: Readonly<Record<Source, string>> = {
  tiingo: "Token ${TIINGO_API_KEY}",
  twelvedata: "apikey ${TWELVEDATA_API_KEY}",
};

const headerSchema = z.strictObject({ key: z.string().min(1), value: z.string() });
const httpTaskSchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  method: z.literal("METHOD_GET"),
  headers: z.array(headerSchema),
});
const jsonParseTaskSchema = z.strictObject({ path: z.string().startsWith("$") });
const jobSchema = z.strictObject({
  tasks: z.tuple([
    z.strictObject({ httpTask: httpTaskSchema }),
    z.strictObject({ jsonParseTask: jsonParseTaskSchema }),
  ]),
});

/**
 * One feed definition file: `oracle/feeds/<TICKER>.<source>.json`. `jobs` is the Switchboard
 * OracleJob list whose hash (with the queue) is the feed hash pinned in Config; the other fields
 * are metadata. `name` is stored on-chain in 32 bytes.
 */
export const feedDefinitionSchema = z.strictObject({
  name: z.string().min(1).max(32),
  ticker: z.enum(TICKERS),
  source: z.enum(SOURCES),
  jobs: z.array(jobSchema).length(1),
});
export type FeedDefinition = z.infer<typeof feedDefinitionSchema>;
export type HttpTask = z.infer<typeof httpTaskSchema>;
export type Job = z.infer<typeof jobSchema>;

const PLACEHOLDER = /\$\{([A-Za-z0-9_]+)\}/g;

/** Every `${NAME}` placeholder in a text, in order of appearance. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
}

/** Repo-relative file name of a definition. */
export function feedFileName(ticker: Ticker, source: Source): string {
  return `${ticker}.${source}.json`;
}

/**
 * Rules beyond the schema: the file name matches the content, the job calls only its own source
 * for its own ticker, and the API key appears only as a placeholder in the Authorization header,
 * so a requester's `variableOverrides` can change the credential but not the data selected.
 */
export function definitionProblems(def: FeedDefinition, fileName: string): string[] {
  const problems: string[] = [];
  if (fileName !== feedFileName(def.ticker, def.source)) {
    problems.push(`file name should be ${feedFileName(def.ticker, def.source)}`);
  }
  const keyVariable = SOURCE_KEY_VARIABLE[def.source];
  const found = placeholders(JSON.stringify(def));
  if (found.length !== 1 || found[0] !== keyVariable) {
    problems.push(`placeholders must be exactly [${keyVariable}], found [${found.join(", ")}]`);
  }
  for (const job of def.jobs) {
    const verifyError = OracleJob.verify(OracleJob.fromObject(job));
    if (verifyError !== null) problems.push(`not a valid OracleJob: ${verifyError}`);
    const [{ httpTask }] = job.tasks;
    problems.push(...httpTaskProblems(def, httpTask));
  }
  return problems;
}

function httpTaskProblems(def: FeedDefinition, task: HttpTask): string[] {
  const problems: string[] = [];
  const url = new URL(task.url);
  if (url.host !== SOURCE_HOST[def.source]) {
    problems.push(`url host must be ${SOURCE_HOST[def.source]}, found ${url.host}`);
  }
  if (!task.url.toUpperCase().includes(def.ticker)) {
    problems.push(`url must name ticker ${def.ticker}`);
  }
  if (placeholders(task.url).length > 0) {
    problems.push("url must not contain placeholders (requesters could change the data)");
  }
  const auth = task.headers.filter((header) => header.key === "Authorization");
  if (auth.length !== 1 || auth[0]?.value !== SOURCE_AUTH_HEADER[def.source]) {
    problems.push(`needs one Authorization header "${SOURCE_AUTH_HEADER[def.source]}"`);
  }
  return problems;
}

/** Parse and check one definition; throws with the file name on any problem. */
export function parseFeedDefinition(raw: string, fileName: string): FeedDefinition {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${fileName}: invalid JSON`, { cause: error });
  }
  const parsed = feedDefinitionSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${fileName}: ${z.prettifyError(parsed.error)}`);
  }
  const problems = definitionProblems(parsed.data, fileName);
  if (problems.length > 0) {
    throw new Error(`${fileName}: ${problems.join("; ")}`);
  }
  return parsed.data;
}

/** Load every definition in a directory; requires exactly one per ticker and source. */
export function loadFeedDefinitions(dir: string): FeedDefinition[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const defs = files.map((name) =>
    parseFeedDefinition(readFileSync(join(dir, name), "utf8"), name),
  );
  const expected = TICKERS.flatMap((ticker) => SOURCES.map((s) => feedFileName(ticker, s))).sort();
  const actual = defs.map((def) => feedFileName(def.ticker, def.source)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${dir}: expected definitions ${expected.join(", ")}; found ${actual.join(", ")}`,
    );
  }
  return orderFeeds(defs);
}

/** Definitions sorted by ticker (TICKERS order), then source slot. */
export function orderFeeds(defs: readonly FeedDefinition[]): FeedDefinition[] {
  const rank = (def: FeedDefinition): number =>
    TICKERS.indexOf(def.ticker) * SOURCES.length + SOURCES.indexOf(def.source);
  return [...defs].sort((a, b) => rank(a) - rank(b));
}
