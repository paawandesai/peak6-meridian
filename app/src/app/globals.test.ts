// @vitest-environment node
/**
 * AC1 / AC2 (UI-02): the tokens in docs/design.md §4 are defined in globals.css for light and dark
 * and exposed as Tailwind theme names, and every text/background and control-border pair used by
 * the components meets WCAG AA in both schemes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contrastRatio } from "@/lib/contrast";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const css = readFileSync(join(APP_DIR, "src/app/globals.css"), "utf8");
const design = readFileSync(join(APP_DIR, "../docs/design.md"), "utf8");

type Tokens = Map<string, string>;

/** `--name: value;` declarations of one block, comments stripped, whitespace normalised. */
function declarations(block: string): Tokens {
  const out: Tokens = new Map();
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(/(--mer-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1] ?? "", (match[2] ?? "").trim().replace(/\s+/g, " ").toLowerCase());
  }
  return out;
}

/** Contents of the `{ ... }` that follows `selector` (no nested braces in the token blocks). */
function blockAfter(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unclosed ${selector}`);
}

const designCss = /```css\n([\s\S]*?)```/.exec(design)?.[1] ?? "";
const designLight = declarations(blockAfter(designCss, ":root"));
const designDark = declarations(
  blockAfter(blockAfter(designCss, "@media (prefers-color-scheme: dark)"), ":root"),
);
const light = declarations(blockAfter(css, ":root"));
const dark = declarations(
  blockAfter(blockAfter(css, "@media (prefers-color-scheme: dark)"), ":root"),
);
/** Dark falls back to light for tokens the dark block does not override. */
const darkResolved: Tokens = new Map([...light, ...dark]);

describe("tokens (AC1)", () => {
  it("design.md §4 defines tokens to compare against", () => {
    expect(designLight.size).toBeGreaterThan(25);
    expect(designDark.size).toBeGreaterThan(10);
  });

  it("defines every design.md token for light with the same value", () => {
    for (const [name, value] of designLight) {
      expect(light.get(name), `light ${name}`).toBe(value);
    }
  });

  it("defines every design.md dark token with the same value", () => {
    for (const [name, value] of designDark) {
      expect(dark.get(name), `dark ${name}`).toBe(value);
    }
  });

  it("every colour token is reachable in dark (overridden or inherited)", () => {
    for (const name of light.keys()) {
      expect(darkResolved.has(name), name).toBe(true);
    }
  });

  it("exposes each colour, spacing, type and radius token as a Tailwind theme name", () => {
    const theme = blockAfter(css, "@theme inline");
    for (const name of light.keys()) {
      const short = name.replace("--mer-", "");
      const mapped =
        theme.includes(`var(${name})`) ||
        // font stacks map to `--font-sans` / `--font-num`
        (short.startsWith("font-") && theme.includes(`var(${name})`));
      expect(mapped, `${name} has a theme mapping`).toBe(true);
    }
  });
});

/** Foreground/background pairs the components use: [foreground, background, minimum ratio]. */
const TEXT_PAIRS: readonly (readonly [string, string, number])[] = [
  ["--mer-ink", "--mer-paper", 4.5],
  ["--mer-ink", "--mer-surface", 4.5],
  ["--mer-ink-muted", "--mer-paper", 4.5],
  ["--mer-ink-muted", "--mer-surface", 4.5],
  ["--mer-yes", "--mer-paper", 4.5],
  ["--mer-yes", "--mer-surface", 4.5],
  ["--mer-no", "--mer-paper", 4.5],
  ["--mer-no", "--mer-surface", 4.5],
  ["--mer-gain", "--mer-paper", 4.5],
  ["--mer-gain", "--mer-surface", 4.5],
  ["--mer-loss", "--mer-paper", 4.5],
  ["--mer-loss", "--mer-surface", 4.5],
  ["--mer-warn", "--mer-paper", 4.5],
  ["--mer-warn", "--mer-surface", 4.5],
  // solid fills (the Settled badges) take their text from the on-* tokens
  ["--mer-on-yes", "--mer-yes", 4.5],
  ["--mer-on-no", "--mer-no", 4.5],
];

/** Non-text contrast (WCAG 1.4.11): control borders and the focus ring. */
const NON_TEXT_PAIRS: readonly (readonly [string, string, number])[] = [
  ["--mer-control-border", "--mer-paper", 3],
  ["--mer-control-border", "--mer-surface", 3],
  ["--mer-focus", "--mer-paper", 3],
  ["--mer-focus", "--mer-surface", 3],
];

function hex(tokens: Tokens, name: string): string {
  const value = tokens.get(name);
  if (value === undefined || !/^#[0-9a-f]{6}$/.test(value)) throw new Error(`${name} is not hex`);
  return value;
}

describe.each([
  ["light", light],
  ["dark", darkResolved],
] as const)("contrast, %s (AC2)", (scheme, tokens) => {
  it.each([...TEXT_PAIRS, ...NON_TEXT_PAIRS])("%s on %s is at least %s:1", (fg, bg, minimum) => {
    const ratio = contrastRatio(hex(tokens, fg), hex(tokens, bg));
    expect(ratio, `${scheme} ${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(minimum);
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 1);
  });
});
