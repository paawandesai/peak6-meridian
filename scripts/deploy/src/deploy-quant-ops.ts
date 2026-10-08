/**
 * Deploys the quant and ops-agent services to Railway (M3-08). Extends the M2-11 platform
 * deployment pattern. Requires M2-11 to be merged first (platform-cli, railway, platform modules).
 *
 * Usage: tsx src/deploy-quant-ops.ts <quant|ops-agent> [--dry-run]
 *
 * Tokens and environment variables come from GitLab CI protected variables, never from files or argv.
 * The deploy verifies /health with the bearer token and logs the public URL.
 */
// These imports will resolve once M2-11 is merged.
// import { dirname, resolve } from "node:path";
// import { fileURLToPath } from "node:url";
// import { runCommand } from "./lib/process";
// import { runPlatformCli } from "./lib/platform-cli";

// const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Entry point placeholder. Once M2-11 is merged, this will call runPlatformCli with quant/ops-agent
 * as valid targets alongside vercel/railway (automation). The platform-cli will:
 * 1. Parse the target (quant | ops-agent) and --dry-run flag
 * 2. Load QUANT_ENV or OPS_AGENT_ENV from quant-ops-env.ts
 * 3. Call deployRailway with the appropriate service name and config file path
 * 4. Verify /health with SERVICE_TOKEN
 * 5. Log the public URL
 *
 * Example integration (after M2-11 merge):
 *
 * runPlatformCli(process.argv.slice(2), process.env, {
 *   repoRoot,
 *   fetch: (url, init) => fetch(url, init),
 *   log: (line) => process.stdout.write(`${line}\n`),
 *   sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
 *   run: (command, args, options) =>
 *     runCommand(command, args, { ...options, timeoutMs: 15 * 60 * 1000 }),
 * }).then(
 *   (code) => {
 *     process.exitCode = code;
 *   },
 *   (error: unknown) => {
 *     process.stderr.write(`deploy-quant-ops: ${error instanceof Error ? error.message : "failed"}\n`);
 *     process.exitCode = 1;
 *   },
 * );
 */

// Temporary message until M2-11 is merged.
process.stderr.write(
  "deploy-quant-ops: blocked on M2-11 (platform-cli, railway modules not yet merged)\n",
);
process.exitCode = 1;
