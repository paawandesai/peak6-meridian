#!/usr/bin/env tsx
/**
 * Deploy services to Railway (M2-11, M3-08).
 *
 * Usage: RAILWAY_TOKEN=... tsx scripts/deploy/src/deploy-railway.ts <service>
 * Where <service> is one of: automation, quant, ops-agent
 *
 * Requires Railway CLI installed and RAILWAY_TOKEN set.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICES = ["automation", "quant", "ops-agent"] as const;
type Service = (typeof SERVICES)[number];

function isService(value: string): value is Service {
  return SERVICES.includes(value as Service);
}

function deploy(service: Service): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const servicePath = resolve(repoRoot, "services", service);

  if (!existsSync(servicePath)) {
    throw new Error(`Service directory not found: ${servicePath}`);
  }

  const railwayJson = resolve(servicePath, "railway.json");
  if (!existsSync(railwayJson)) {
    console.warn(`Warning: ${service}/railway.json not found, using Railway defaults`);
  }

  console.log(`Deploying ${service} to Railway...`);
  process.chdir(servicePath);

  try {
    // Railway CLI: link and deploy the service
    // The RAILWAY_SERVICE_NAME env var tells Railway which service to deploy
    execSync(`railway up --service ${service}`, {
      stdio: "inherit",
      env: {
        ...process.env,
        RAILWAY_SERVICE_NAME: service,
      },
    });
    console.log(`✓ ${service} deployed successfully`);
  } catch (error) {
    throw new Error(`Failed to deploy ${service}: ${error}`);
  }
}

function main(): void {
  const service = process.argv[2];

  if (!service || !isService(service)) {
    console.error(`Usage: deploy-railway.ts <service>`);
    console.error(`Services: ${SERVICES.join(", ")}`);
    process.exit(1);
  }

  if (!process.env.RAILWAY_TOKEN) {
    throw new Error("RAILWAY_TOKEN environment variable is required");
  }

  deploy(service);
}

main();
