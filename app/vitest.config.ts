import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next.js needs `jsx: "preserve"` in tsconfig.json; tests compile JSX themselves.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}"],
      reporter: ["text"],
      thresholds: { lines: 80 },
    },
  },
});
