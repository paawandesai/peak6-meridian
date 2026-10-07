import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["ab_*.test.ts", "feeds_no_secrets.test.ts"],
  },
});
