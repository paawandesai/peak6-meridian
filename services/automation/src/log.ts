/**
 * Structured logging (CLAUDE.md § Conventions): one JSON object per line. Callers pass only
 * non-secret fields; error text goes through [`describeError`], which strips URLs because RPC and
 * webhook URLs can embed credentials.
 */
export type LogLevel = "info" | "warn" | "error";

export type Logger = (
  level: LogLevel,
  event: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

/** Writes one JSON line per event to stdout (stderr for errors). */
export const consoleLogger: Logger = (level, event, fields) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
};

/** A logger that drops everything (tests that do not assert on logs). */
export const silentLogger: Logger = () => undefined;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** An error's message with every URL replaced by `<url>`, truncated to 500 characters. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(URL_PATTERN, "<url>").slice(0, 500);
}
