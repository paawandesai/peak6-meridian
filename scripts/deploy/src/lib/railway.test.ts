import { describe, expect, it } from "vitest";

import type { PlatformDeps } from "./platform";
import { checkHealth, CONFIG_FILE, deployRailway, type RailwayOptions } from "./railway";

const TOKEN = "railway-token-SECRET";
const KEYPAIR = "[7,7,7,7,7,7,7,7]";
const SERVICE_TOKEN = "service-bearer-123";
const env = {
  SOLANA_CLUSTER: "devnet",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  MERIDIAN_PROGRAM_ID: "Prog1111",
  AUTOMATION_KEYPAIR: KEYPAIR,
  SERVICE_TOKEN,
  TIINGO_API_KEY: "tiingo-key-xyz",
  TWELVEDATA_API_KEY: "twelve-key-xyz",
  SWITCHBOARD_QUEUE: "Queue111",
  SWITCHBOARD_FEEDS_JSON: "{}",
};
const options: RailwayOptions = {
  token: TOKEN,
  projectName: "meridian",
  serviceName: "automation",
  cliVersion: "9.9.9",
  env,
  repoRoot: "/repo",
  healthAttempts: 2,
  healthIntervalMs: 1,
};

type Mode = "project-token" | "account-existing" | "account-new";

function fakes(mode: Mode, healthStatuses: number[] = [200]) {
  const queries: string[] = [];
  const headersSeen: Record<string, string>[] = [];
  const logs: string[] = [];
  const health = [...healthStatuses];
  const deps: PlatformDeps = {
    log: (line) => logs.push(line),
    sleep: async () => undefined,
    fetch: async (url, init) => {
      if (url.endsWith("/health")) {
        return new Response("{}", { status: health.shift() ?? 503 });
      }
      const headers = init.headers as Record<string, string>;
      headersSeen.push(headers);
      const { query } = JSON.parse(String(init.body)) as { query: string };
      queries.push(query);
      const reply = (data: unknown, status = 200) =>
        new Response(JSON.stringify({ data }), { status });
      if (query.includes("projectToken")) {
        return mode === "project-token"
          ? reply({ projectToken: { projectId: "p1", environmentId: "e1" } })
          : new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), {
              status: 200,
            });
      }
      const env1 = { edges: [{ node: { id: "e1", name: "production" } }] };
      if (query.includes("projects {")) {
        return reply({
          projects: {
            edges:
              mode === "account-existing"
                ? [{ node: { id: "p1", name: "meridian", environments: env1 } }]
                : [],
          },
        });
      }
      if (query.includes("projectCreate"))
        return reply({ projectCreate: { id: "p1", name: "meridian", environments: env1 } });
      if (query.includes("services {")) return reply({ project: { services: { edges: [] } } });
      if (query.includes("serviceCreate")) return reply({ serviceCreate: { id: "s1" } });
      if (query.includes("domains(")) return reply({ domains: { serviceDomains: [] } });
      if (query.includes("serviceDomainCreate"))
        return reply({ serviceDomainCreate: { domain: "auto.up.railway.app" } });
      return reply({ ok: true });
    },
  };
  return { deps, queries, headersSeen, logs };
}

describe("deployRailway", () => {
  it("project token: uses its project, sets variables and config file, uploads, checks health", async () => {
    const { deps, queries, headersSeen, logs } = fakes("project-token");
    let runEnv: NodeJS.ProcessEnv = {};
    let runArgs: readonly string[] = [];
    const result = await deployRailway(deps, options, async (_c, args, o) => {
      runArgs = args;
      runEnv = o.env;
      return { stdout: "" };
    });
    expect(result.url).toBe("https://auto.up.railway.app");
    expect(queries.some((q) => q.includes("projectCreate"))).toBe(false);
    expect(queries.some((q) => q.includes("variableCollectionUpsert"))).toBe(true);
    expect(queries.some((q) => q.includes("serviceInstanceUpdate"))).toBe(true);
    expect(headersSeen[0]?.["Project-Access-Token"]).toBe(TOKEN);
    expect(runEnv.RAILWAY_TOKEN).toBe(TOKEN);
    expect(runEnv.RAILWAY_API_TOKEN).toBeUndefined();
    expect(runArgs.join(" ")).toContain("@railway/cli@9.9.9 up --ci --service automation");
    expect(runArgs.join(" ")).not.toContain(TOKEN);
    expect(CONFIG_FILE).toBe("services/automation/railway.json");
    const output = logs.join("\n");
    for (const secret of [TOKEN, KEYPAIR, SERVICE_TOKEN, "tiingo-key-xyz"]) {
      expect(output).not.toContain(secret);
    }
  });

  it("account token: reuses an existing project by name", async () => {
    const { deps, queries, headersSeen } = fakes("account-existing");
    let runEnv: NodeJS.ProcessEnv = {};
    await deployRailway(deps, options, async (_c, _a, o) => {
      runEnv = o.env;
      return { stdout: "" };
    });
    expect(queries.some((q) => q.includes("projectCreate"))).toBe(false);
    expect(headersSeen.at(-1)?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(runEnv.RAILWAY_API_TOKEN).toBe(TOKEN);
    expect(runEnv.RAILWAY_TOKEN).toBeUndefined();
  });

  it("account token: creates the project when absent", async () => {
    const { deps, queries } = fakes("account-new");
    await deployRailway(deps, options, async () => ({ stdout: "" }));
    expect(queries.some((q) => q.includes("projectCreate"))).toBe(true);
  });

  it("refuses before any network call when required variables are missing", async () => {
    const { deps, queries } = fakes("project-token");
    await expect(
      deployRailway(
        deps,
        { ...options, env: { ...env, AUTOMATION_KEYPAIR: undefined } },
        async () => ({ stdout: "" }),
      ),
    ).rejects.toThrow(/missing required variables: AUTOMATION_KEYPAIR/);
    expect(queries).toHaveLength(0);
  });

  it("fails when /health never returns 200", async () => {
    const { deps } = fakes("project-token", [401, 503]);
    await expect(deployRailway(deps, options, async () => ({ stdout: "" }))).rejects.toThrow(
      /not healthy after 2 attempts \(last status 503\)/,
    );
  });

  it("redacts secrets from a failing CLI", async () => {
    const { deps } = fakes("project-token");
    await expect(
      deployRailway(deps, options, async () => {
        throw new Error(`upload failed ${TOKEN} ${KEYPAIR}`);
      }),
    ).rejects.toThrow(/upload failed \*\*\* \*\*\*/);
  });
});

describe("checkHealth", () => {
  it("succeeds after a retry and sends the bearer", async () => {
    const seen: string[] = [];
    let n = 0;
    const deps: PlatformDeps = {
      log: () => undefined,
      sleep: async () => undefined,
      fetch: async (_u, init) => {
        seen.push((init.headers as Record<string, string>).Authorization ?? "");
        n += 1;
        if (n === 1) throw new Error("ECONNREFUSED");
        return new Response("{}", { status: 200 });
      },
    };
    await checkHealth(deps, "https://x", "tok", 3, 1);
    expect(seen).toEqual(["Bearer tok", "Bearer tok"]);
  });
});
