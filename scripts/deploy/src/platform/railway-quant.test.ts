// M3-08b: the quant service as its own Railway service (`quant`), same flow as automation.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { QUANT_ENV, type PlatformDeps } from "./platform";
import {
  AUTOMATION_TARGET,
  CONFIG_FILE,
  deployRailway,
  planRailway,
  QUANT_CONFIG_FILE,
  QUANT_TARGET,
  serviceSettings,
  type RailwayOptions,
} from "./railway";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const TOKEN = "railway-token-SECRET";
const KEYPAIR = "[9,9,9,9,9,9,9,9]";
const SERVICE_TOKEN = "service-bearer-quant-123";
const RPC = "https://devnet.helius-rpc.com/?api-key=rpc-key-SECRET";
const env = {
  MARKET_MAKER_KEYPAIR: KEYPAIR,
  MERIDIAN_PROGRAM_ID: "Prog1111",
  USDC_MINT: "Mint1111",
  SERVICE_TOKEN,
  FINNHUB_API_KEY: "finnhub-key-xyz",
  TIINGO_API_KEY: "tiingo-key-xyz",
  SOLANA_RPC_URL: RPC,
  SOLANA_CLUSTER: "devnet",
  PYTH_API_TOKEN: "pyth-token-xyz",
  // Not part of the quant spec: must never be sent to the quant service.
  AUTOMATION_KEYPAIR: "[1,1,1,1,1,1,1,1]",
};
const options: RailwayOptions = {
  token: TOKEN,
  projectName: "meridian",
  serviceName: "quant",
  env,
  repoRoot: REPO_ROOT,
  healthAttempts: 2,
  healthIntervalMs: 1,
  target: QUANT_TARGET,
};

function fakes(healthStatuses: number[] = [200]) {
  const bodies: string[] = [];
  const healthUrls: string[] = [];
  const logs: string[] = [];
  const health = [...healthStatuses];
  const deps: PlatformDeps = {
    log: (line) => logs.push(line),
    sleep: async () => undefined,
    fetch: async (url, init) => {
      if (!url.startsWith("https://backboard.railway.com")) {
        healthUrls.push(url);
        return new Response("{}", { status: health.shift() ?? 503 });
      }
      const { query } = JSON.parse(String(init.body)) as { query: string };
      bodies.push(String(init.body));
      const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
      if (query.includes("projectToken"))
        return reply({ projectToken: { projectId: "p1", environmentId: "e1" } });
      if (query.includes("services {")) return reply({ project: { services: { edges: [] } } });
      if (query.includes("serviceCreate")) return reply({ serviceCreate: { id: "sq" } });
      if (query.includes("domains(")) return reply({ domains: { serviceDomains: [] } });
      if (query.includes("serviceDomainCreate"))
        return reply({ serviceDomainCreate: { domain: "quant.up.railway.app" } });
      return reply({ ok: true });
    },
  };
  return { deps, bodies, healthUrls, logs };
}

describe("QUANT_TARGET", () => {
  it("names the quant service config, health path and spec", () => {
    expect(QUANT_TARGET.label).toBe("quant");
    expect(QUANT_TARGET.configFile).toBe("/services/quant/railway.json");
    expect(QUANT_CONFIG_FILE).toBe("/services/quant/railway.json");
    expect(QUANT_TARGET.healthPath).toBe("/health");
    expect(QUANT_TARGET.envSpec).toBe(QUANT_ENV);
    expect(QUANT_TARGET.fixedVariables).toEqual({
      RAILPACK_CONFIG_FILE: "services/quant/railpack.json",
    });
  });

  it("requires the MM keypair, chain ids, bearer, data keys and RPC; Pyth is optional", () => {
    expect([...QUANT_ENV.required].sort()).toEqual(
      [
        "FINNHUB_API_KEY",
        "MARKET_MAKER_KEYPAIR",
        "MERIDIAN_PROGRAM_ID",
        "SERVICE_TOKEN",
        "SOLANA_CLUSTER",
        "SOLANA_RPC_URL",
        "TIINGO_API_KEY",
        "USDC_MINT",
      ].sort(),
    );
    expect([...QUANT_ENV.optional].sort()).toEqual(
      [
        "MERIDIAN_DEMO_ALLOW_STALE_SPOT",
        "MERIDIAN_DEVNET_RPC_URL",
        "PYTH_API_TOKEN",
        "SOLANA_WS_URL",
      ].sort(),
    );
  });

  it("leaves the automation target as it was", () => {
    expect(AUTOMATION_TARGET.configFile).toBe(CONFIG_FILE);
    expect(AUTOMATION_TARGET.fixedVariables).toEqual({});
    expect(AUTOMATION_TARGET.healthPath).toBe("/health");
  });
});

describe("planRailway (quant)", () => {
  it("collects only the quant variables and reports missing ones by name", () => {
    const plan = planRailway(options);
    expect(Object.keys(plan.values)).not.toContain("AUTOMATION_KEYPAIR");
    expect(plan.missingRequired).toEqual([]);
    expect(plan.missingOptional).toEqual([
      "MERIDIAN_DEMO_ALLOW_STALE_SPOT",
      "MERIDIAN_DEVNET_RPC_URL",
      "SOLANA_WS_URL",
    ]);
    const partial = planRailway({ ...options, env: { SOLANA_CLUSTER: "devnet" } });
    expect(partial.missingRequired).toContain("MARKET_MAKER_KEYPAIR");
    expect(partial.missingOptional).toContain("PYTH_API_TOKEN");
  });
});

describe("serviceSettings (quant)", () => {
  it("applies the quant railway.json build, start, health path and restart policy", () => {
    const settings = serviceSettings(REPO_ROOT, QUANT_CONFIG_FILE);
    expect(settings.builder).toBe("RAILPACK");
    expect(settings.buildCommand).toBe(
      "uv sync --locked --package meridian_quant --no-dev --no-editable",
    );
    expect(String(settings.startCommand)).toContain("QUANT_PORT=${PORT:-4100}");
    expect(String(settings.startCommand)).toContain(
      "exec /app/.venv/bin/python -m meridian_quant.mm.main",
    );
    expect(settings.healthcheckPath).toBe("/health");
    expect(settings.restartPolicyType).toBe("ON_FAILURE");
    expect(settings.restartPolicyMaxRetries).toBe(10);
  });

  it("automation settings carry no health path (unchanged M2-11 input)", () => {
    expect(serviceSettings(REPO_ROOT)).not.toHaveProperty("healthcheckPath");
  });
});

describe("deployRailway (quant)", () => {
  it("deploys service quant with its config, variables and /health; prints no secret", async () => {
    const { deps, bodies, healthUrls, logs } = fakes();
    let runArgs: readonly string[] = [];
    let runEnv: NodeJS.ProcessEnv = {};
    const result = await deployRailway(deps, options, async (_c, args, o) => {
      runArgs = args;
      runEnv = o.env;
      return { stdout: "" };
    });
    expect(result.url).toBe("https://quant.up.railway.app");
    expect(runArgs.join(" ")).toContain("up --ci --project p1 --service quant --environment e1");
    expect(healthUrls).toEqual(["https://quant.up.railway.app/health"]);

    const upsert = JSON.parse(bodies.find((b) => b.includes("variableCollectionUpsert")) ?? "{}");
    const variables = upsert.variables.input.variables as Record<string, string>;
    expect(variables.RAILPACK_CONFIG_FILE).toBe("services/quant/railpack.json");
    expect(variables.MARKET_MAKER_KEYPAIR).toBe(KEYPAIR);
    expect(variables.PYTH_API_TOKEN).toBe("pyth-token-xyz");
    expect(variables).not.toHaveProperty("AUTOMATION_KEYPAIR");
    expect(upsert.variables.input.serviceId).toBe("sq");

    const update = bodies.find((b) => b.includes("serviceInstanceUpdate")) ?? "";
    expect(update).toContain("meridian_quant.mm.main");
    expect(update).toContain('"healthcheckPath":"/health"');

    const output = logs.join("\n");
    expect(output).toContain("railway: set 10 variables:");
    expect(output).toContain("RAILPACK_CONFIG_FILE");
    for (const secret of [
      TOKEN,
      KEYPAIR,
      SERVICE_TOKEN,
      RPC,
      "rpc-key-SECRET",
      "finnhub-key-xyz",
      "tiingo-key-xyz",
      "pyth-token-xyz",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(Object.keys(runEnv)).not.toContain("MARKET_MAKER_KEYPAIR");
  });

  it("refuses before any network call when a required variable is missing", async () => {
    const { deps, bodies } = fakes();
    await expect(
      deployRailway(
        deps,
        { ...options, env: { ...env, MARKET_MAKER_KEYPAIR: undefined } },
        async () => ({ stdout: "" }),
      ),
    ).rejects.toThrow(/missing required variables: MARKET_MAKER_KEYPAIR/);
    expect(bodies).toHaveLength(0);
  });

  it("fails naming the health path when /health never answers 200", async () => {
    const { deps } = fakes([502, 502]);
    await expect(deployRailway(deps, options, async () => ({ stdout: "" }))).rejects.toThrow(
      /quant\.up\.railway\.app\/health not healthy after 2 attempts \(last status 502\)/,
    );
  });

  it("redacts secrets from a failing CLI", async () => {
    const { deps } = fakes();
    await expect(
      deployRailway(deps, options, async () => {
        throw new Error(`upload failed ${SERVICE_TOKEN} ${RPC}`);
      }),
    ).rejects.toThrow(/upload failed \*\*\* \*\*\*/);
  });
});

describe("services/quant/railpack.json", () => {
  const railpack = JSON.parse(
    readFileSync(join(REPO_ROOT, "services/quant/railpack.json"), "utf8"),
  ) as { provider: string; packages: Record<string, string> };

  it("forces the Python provider and pins uv to an exact version", () => {
    expect(railpack.provider).toBe("python");
    expect(railpack.packages.uv).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
