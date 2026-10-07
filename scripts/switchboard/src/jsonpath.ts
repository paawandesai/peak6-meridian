/**
 * The JSONPath subset the feed definitions use: `$`, `.name`, `['name']` and `[index]`. Enough to
 * run the jobs offline against fixtures; the oracles use a full implementation (jsonpath-plus).
 */
export type PathSegment = string | number;

const SEGMENT = /^(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]|\['([^']*)'\])/;

/** Parse a path into segments; throws on anything outside the subset. */
export function parsePath(path: string): PathSegment[] {
  if (!path.startsWith("$")) throw new Error(`JSONPath must start with $: ${path}`);
  const segments: PathSegment[] = [];
  let rest = path.slice(1);
  while (rest.length > 0) {
    const match = SEGMENT.exec(rest);
    if (match === null) throw new Error(`unsupported JSONPath at "${rest}" in ${path}`);
    const [token, name, index, quoted] = match;
    segments.push(index !== undefined ? Number(index) : (name ?? quoted ?? ""));
    rest = rest.slice(token.length);
  }
  return segments;
}

/** The value at `path`, or undefined if any step is missing. */
export function selectPath(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const segment of parsePath(path)) {
    if (typeof segment === "number") {
      current = Array.isArray(current) ? current[segment] : undefined;
    } else if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      current = Object.hasOwn(current, segment)
        ? (current as Record<string, unknown>)[segment]
        : undefined;
    } else {
      current = undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}
