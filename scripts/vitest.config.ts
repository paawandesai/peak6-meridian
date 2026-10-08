import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts", "test-support/**/*.test.ts", "integration/**/*.test.ts"],
    // The local-validator tests share one validator, one build and tracked files they restore.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
      // `chain-io.ts` and `deploy.ts` are the I/O shell (RPC, `solana` CLI, `make`); the
      // local-validator tests in integration/ cover them end to end and the unit-test
      // coverage run (`pnpm coverage`) does not start a validator.
      exclude: [
        "lib/**/*.test.ts",
        "lib/test-helpers.ts",
        "lib/deploy.ts",
        "lib/chain-io.ts",
        "lib/process.ts",
      ],
      reporter: ["text"],
      thresholds: { lines: 80 },
    },
  },
});
