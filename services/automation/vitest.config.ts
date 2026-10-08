import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/cli/create-markets.ts",
        "src/main.ts",
        "src/settle-now.ts",
        "src/runtime.ts",
      ],
      reporter: ["text"],
      thresholds: { lines: 80 },
    },
  },
});
