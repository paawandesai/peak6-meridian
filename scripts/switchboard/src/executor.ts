import { toScaled18 } from "./decimal";
import { placeholders, type HttpTask, type Job } from "./feeds";
import { selectPath } from "./jsonpath";

/** An HTTP GET as an oracle would send it, after placeholder substitution. */
export interface HttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Returns the response body text for a request (fixtures in dry-run). */
export type HttpFetcher = (request: HttpRequest) => string;

/** Replace `${NAME}` placeholders; an unresolved or empty one fails, as it does on the oracles. */
export function substitute(text: string, variables: Readonly<Record<string, string>>): string {
  for (const name of placeholders(text)) {
    const value = variables[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`unresolved variable \${${name}}`);
    }
  }
  return text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name: string) => variables[name] ?? "");
}

/** Build the request an httpTask makes. */
export function buildRequest(
  task: HttpTask,
  variables: Readonly<Record<string, string>>,
): HttpRequest {
  const headers: Record<string, string> = {};
  for (const header of task.headers) headers[header.key] = substitute(header.value, variables);
  return { url: substitute(task.url, variables), headers };
}

/**
 * Run a feed job offline: the httpTask goes to `fetch`, the jsonParseTask selects the value.
 * Returns the value scaled by 10^18. Mirrors oracle behaviour for the two task types we use:
 * a missing path or a non-numeric value is an error, never a zero.
 */
export function runJob(
  job: Job,
  fetch: HttpFetcher,
  variables: Readonly<Record<string, string>>,
): bigint {
  const [{ httpTask }, { jsonParseTask }] = job.tasks;
  const body = fetch(buildRequest(httpTask, variables));
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch (error) {
    throw new Error(`response from ${new URL(httpTask.url).host} is not JSON`, { cause: error });
  }
  const value = selectPath(document, jsonParseTask.path);
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`no numeric value at ${jsonParseTask.path}`);
  }
  return toScaled18(value);
}
