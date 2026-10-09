import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fast mocked unit and property tests only. The validator-backed tests are
    // test/deploy/*.deploy.test.ts and run through `make test-deploy-devnet`.
    include: ["src/**/*.test.ts"],
    exclude: ["test/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/platform/**/*.ts"],
      // `deploy.ts`, `chain-io.ts` and `process.ts` are the I/O shell (RPC, `solana`, `anchor`);
      // the validator-backed tests cover them end to end. The 80% line floor is measured on the
      // unit tests alone and holds without the heavy tests.
      exclude: [
        "src/lib/**/*.test.ts",
        "src/platform/**/*.test.ts",
        "src/lib/test-helpers.ts",
        "src/lib/deploy.ts",
        "src/lib/chain-io.ts",
        "src/lib/process.ts",
      ],
      reporter: ["text"],
      thresholds: { lines: 80 },
    },
  },
});
