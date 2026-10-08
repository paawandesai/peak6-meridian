import { defineConfig } from "vitest/config";

// The local-validator tests (`make test-deploy-devnet`): one build in an isolated copy and a
// handful of validators, strictly serial. Kept out of `pnpm -r test`, which runs packages
// concurrently next to suites that use the shared target/.
export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 2_400_000,
  },
});
