import { readFileSync } from "node:fs";

import { z } from "zod";

import { formatScaled18 } from "./decimal";
import { runJob, type HttpFetcher } from "./executor";
import { SOURCE_KEY_VARIABLE, SOURCES } from "./feeds";
import type { UpdateSimulator } from "./spike";

/** Recorded-shape API responses and a fake oracle set for `--dry-run` (no network). */
export const fixtureSchema = z.strictObject({
  slot: z.number().int().nonnegative(),
  oracles: z.array(z.string().min(32)).min(1),
  responses: z.record(z.url(), z.unknown()),
});
export type SpikeFixture = z.infer<typeof fixtureSchema>;

/** Stand-in credentials: dry-run never reads real keys. */
export const DRY_RUN_VARIABLES: Readonly<Record<string, string>> = Object.fromEntries(
  SOURCES.map((source) => [SOURCE_KEY_VARIABLE[source], "dry-run"]),
);

export function loadFixture(path: string): SpikeFixture {
  const parsed = fixtureSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Answers a request from the fixture, like the API would: 401 without a key, 404 if unknown. */
export function fixtureFetcher(fixture: SpikeFixture): HttpFetcher {
  return (request) => {
    const auth = request.headers["Authorization"] ?? "";
    if (!/^\S+ \S+$/.test(auth)) throw new Error(`HTTP 401 from ${new URL(request.url).host}`);
    if (!Object.hasOwn(fixture.responses, request.url)) {
      throw new Error(`HTTP 404 from ${new URL(request.url).host}`);
    }
    return JSON.stringify(fixture.responses[request.url]);
  };
}

/** Every fixture oracle runs the job against the fixture responses. */
export function fixtureSimulator(fixture: SpikeFixture): UpdateSimulator {
  const fetch = fixtureFetcher(fixture);
  return {
    simulate: (def) =>
      Promise.resolve({
        feed: null,
        slot: fixture.slot,
        oracles: fixture.oracles.map((oracle) => {
          try {
            const scaled = def.jobs.map((job) => runJob(job, fetch, DRY_RUN_VARIABLES))[0];
            return {
              oracle,
              value: scaled === undefined ? null : formatScaled18(scaled),
              error: null,
            };
          } catch (error) {
            return { oracle, value: null, error: error instanceof Error ? error.message : "error" };
          }
        }),
      }),
  };
}
