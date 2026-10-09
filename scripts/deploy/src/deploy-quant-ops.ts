#!/usr/bin/env tsx
/**
 * Deploy quant and ops-agent services to Railway (M3-08). Extends the M2-11 deployRailway pattern
 * with service-specific configs, env specs, and health probes. AC1 requires /fair-values (quant)
 * and /drafts (ops-agent) reachable with the bearer token.
 *
 * Usage: tsx scripts/deploy/src/deploy-quant-ops.ts <quant|ops-agent> [--dry-run]
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "./lib/process";
import { deployRailway, planRailway, type RailwayRun } from "./platform/railway";
import type { PlatformDeps } from "./platform/platform";
import {
  QUANT_ENV,
  OPS_AGENT_ENV,
  QUANT_CONFIG_FILE,
  OPS_AGENT_CONFIG_FILE,
} from "./lib/quant-ops-env";

export type CliDeps = PlatformDeps & {
  readonly repoRoot: string;
  readonly run: RailwayRun;
};

const USAGE = "usage: deploy-quant-ops <quant|ops-agent> [--dry-run]\n";

type ServiceConfig = {
  serviceName: string;
  configFile: string;
  envSpec: typeof QUANT_ENV;
  healthPath: string;
};

const SERVICES: Record<string, ServiceConfig> = {
  quant: {
    serviceName: "quant",
    configFile: QUANT_CONFIG_FILE,
    envSpec: QUANT_ENV,
    healthPath: "/fair-values",
  },
  "ops-agent": {
    serviceName: "ops-agent",
    configFile: OPS_AGENT_CONFIG_FILE,
    envSpec: OPS_AGENT_ENV,
    healthPath: "/drafts",
  },
};

export async function runQuantOpsDeployCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: CliDeps,
): Promise<number> {
  const [target, ...flags] = argv;
  const dryRun = flags.includes("--dry-run");

  if (!target || !(target in SERVICES) || flags.some((flag) => flag !== "--dry-run")) {
    deps.log(USAGE.trimEnd());
    return 2;
  }

  // TypeScript type narrowing: target is now guaranteed to be a key of SERVICES
  const config = SERVICES[target as "quant" | "ops-agent"]!;
  const projectName = env.DEPLOY_PROJECT_NAME ?? "meridian";
  const options = {
    token: env.RAILWAY_TOKEN ?? "",
    projectName: env.RAILWAY_PROJECT_NAME ?? projectName,
    serviceName: config.serviceName,
    configFile: config.configFile,
    envSpec: config.envSpec,
    healthPath: config.healthPath,
    env,
    repoRoot: deps.repoRoot,
  };

  if (dryRun) {
    const collected = planRailway(options);
    deps.log(`${target} dry run (names only):`);
    deps.log(`  token: ${options.token === "" ? "MISSING" : "present"}`);
    deps.log(`  service: ${config.serviceName}`);
    deps.log(`  config: ${config.configFile}`);
    deps.log(`  health probe: ${config.healthPath}`);
    deps.log(`  will set: ${Object.keys(collected.values).join(", ") || "(none)"}`);
    deps.log(`  missing required: ${collected.missingRequired.join(", ") || "(none)"}`);
    deps.log(`  missing optional: ${collected.missingOptional.join(", ") || "(none)"}`);
    return collected.missingRequired.length > 0 || options.token === "" ? 1 : 0;
  }

  if (options.token === "") {
    deps.log("deploy-quant-ops: RAILWAY_TOKEN is not set");
    return 1;
  }

  const result = await deployRailway(deps, options, deps.run);
  deps.log(`${target} URL: ${result.url}`);
  deps.log(`${target} ${config.healthPath} verified with bearer token`);
  return 0;
}

// CLI entry point - runs directly like deploy-platform.ts
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

runQuantOpsDeployCli(process.argv.slice(2), process.env, {
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
    process.stderr.write(
      `deploy-quant-ops: ${error instanceof Error ? error.message : "failed"}\n`,
    );
    process.exitCode = 1;
  },
);
