import { createRequire } from "node:module";
import { realpathSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

/**
 * OQ-12 (b): pnpm.overrides must wire @solana/buffer-layout-utils → in-repo
 * @meridian/bigint-buffer-js (upstream 1.1.5 pure-JS semantics, no native addon).
 * Keeps Switchboard/SDK u64/u128 layout behavior equivalent to upstream.
 */
describe("bigint-buffer override (OQ-12 option b)", () => {
  const require = createRequire(import.meta.url);

  function loadBufferLayoutUtils(): {
    u64: (property?: string) => {
      encode: (n: bigint, buffer: Buffer, offset?: number) => number;
      decode: (buffer: Buffer, offset?: number) => bigint;
    };
    u128: (property?: string) => {
      encode: (n: bigint, buffer: Buffer, offset?: number) => number;
      decode: (buffer: Buffer, offset?: number) => bigint;
    };
  } {
    // Transitive via @switchboard-xyz/on-demand → @solana/spl-token.
    const spl = dirname(require.resolve("@solana/spl-token"));
    return require(require.resolve("@solana/buffer-layout-utils", { paths: [spl] }));
  }

  function resolvedBigintBufferDir(): string {
    const bluEntry = require.resolve("@solana/buffer-layout-utils", {
      paths: [dirname(require.resolve("@solana/spl-token"))],
    });
    const bb = require.resolve("bigint-buffer", { paths: [dirname(bluEntry)] });
    return realpathSync(dirname(bb));
  }

  it("resolves bigint-buffer to the in-repo pure-JS package (no native addon)", () => {
    const dir = resolvedBigintBufferDir();
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
    };
    expect(pkg.name).toBe("@meridian/bigint-buffer-js");
    expect(dir.replace(/\\/g, "/")).toContain("/packages/bigint-buffer-js");
    expect(existsSync(join(dir, "build"))).toBe(false);
    expect(readdirSync(dir).some((f) => f.endsWith(".node"))).toBe(false);
  });

  it("round-trips u64/u128 through @solana/buffer-layout-utils (property)", () => {
    const { u64, u128 } = loadBufferLayoutUtils();
    const layout64 = u64();
    const layout128 = u128();
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (n) => {
        const buf = Buffer.alloc(8);
        layout64.encode(n, buf, 0);
        expect(layout64.decode(buf)).toBe(n);
      }),
    );
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), (n) => {
        const buf = Buffer.alloc(16);
        layout128.encode(n, buf, 0);
        expect(layout128.decode(buf)).toBe(n);
      }),
    );
  });
});
