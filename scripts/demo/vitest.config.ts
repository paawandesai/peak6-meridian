import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The two CLI entry points and the Anchor/RPC adapter are the I/O shell; the logic they
      // wire together is unit-tested with fakes.
      exclude: ["src/**/*.test.ts", "src/demo-markets.ts", "src/demo-settle.ts", "src/chain.ts"],
      reporter: ["text"],
      thresholds: { lines: 80 },
    },
  },
});
