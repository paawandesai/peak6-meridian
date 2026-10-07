import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["index.js"],
      reporter: ["text"],
      thresholds: { lines: 80 },
    },
  },
});
