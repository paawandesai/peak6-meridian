import { defineConfig } from "vitest/config";

// The validator-backed tests (`make test-deploy-devnet`): one cold devnet build in an isolated
// copy of the sources and a handful of validators, strictly serial. Never part of `test` or
// `coverage`, and not run inside `pnpm -r`.
export default defineConfig({
  test: {
    include: ["test/deploy/**/*.deploy.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 2_400_000,
  },
});
