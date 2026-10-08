// Deploys the app to Vercel and the automation service to Railway (M2-11).
// Usage: tsx src/deploy-platform.ts <vercel|railway> [--dry-run]
// Tokens come from the environment (GitLab CI variables), never from files or argv.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "./lib/process";
import { runPlatformCli } from "./lib/platform-cli";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

runPlatformCli(process.argv.slice(2), process.env, {
  repoRoot,
  fetch: (url, init) => fetch(url, init),
  log: (line) => process.stdout.write(`${line}\n`),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  run: (command, args, options) =>
    runCommand(command, args, { ...options, timeoutMs: 15 * 60 * 1000 }),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`deploy-platform: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  },
);
