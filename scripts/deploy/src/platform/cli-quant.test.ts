// M3-08b: `deploy-platform railway-quant [--dry-run]`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runPlatformCli, type CliDeps } from "./cli";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SECRETS = {
  RAILWAY_TOKEN: "railway-tok-SECRET",
  MARKET_MAKER_KEYPAIR: "[5,5,5,5,5,5,5,5]",
  SERVICE_TOKEN: "svc-token-SECRET",
  FINNHUB_API_KEY: "finnhub-SECRET",
  TIINGO_API_KEY: "tiingo-SECRET",
  SOLANA_RPC_URL: "https://rpc.example/?api-key=rpc-SECRET",
  PYTH_API_TOKEN: "pyth-SECRET",
};
const FULL_ENV = {
  ...SECRETS,
  MERIDIAN_PROGRAM_ID: "Prog1111",
  USDC_MINT: "Mint1111",
  SOLANA_CLUSTER: "devnet",
};

function deps(): { deps: CliDeps; logs: string[]; fetched: string[]; ran: string[][] } {
  const logs: string[] = [];
  const fetched: string[] = [];
  const ran: string[][] = [];
  return {
    logs,
    fetched,
    ran,
    deps: {
      repoRoot: REPO_ROOT,
      log: (line) => logs.push(line),
      sleep: async () => undefined,
      fetch: async (url, init) => {
        fetched.push(url);
        if (!url.startsWith("https://backboard.railway.com")) return new Response("{}");
        const { query } = JSON.parse(String(init.body)) as { query: string };
        const reply = (data: unknown) => new Response(JSON.stringify({ data }));
        if (query.includes("projectToken"))
          return reply({ projectToken: { projectId: "p1", environmentId: "e1" } });
        if (query.includes("services {"))
          return reply({
            project: { services: { edges: [{ node: { id: "s9", name: "quant" } }] } },
          });
        if (query.includes("domains("))
          return reply({ domains: { serviceDomains: [{ domain: "quant.up.railway.app" }] } });
        return reply({ ok: true });
      },
      run: async (_command, args) => {
        ran.push([...args]);
        return { stdout: "" };
      },
    },
  };
}

describe("runPlatformCli railway-quant", () => {
  it("dry run prints service, config, health path and variable names only; no network", async () => {
    const d = deps();
    expect(await runPlatformCli(["railway-quant", "--dry-run"], FULL_ENV, d.deps)).toBe(0);
    const out = d.logs.join("\n");
    expect(out).toContain(
      "railway-quant: service quant, config /services/quant/railway.json, health /health",
    );
    expect(out).toContain("railway-quant dry run (names only):");
    expect(out).toContain("token: present");
    expect(out).toContain("MARKET_MAKER_KEYPAIR");
    expect(out).toContain("missing required: (none)");
    expect(out).toContain(
      "missing optional: MERIDIAN_DEMO_ALLOW_STALE_SPOT, MERIDIAN_DEVNET_RPC_URL, SOLANA_WS_URL",
    );
    for (const secret of Object.values(SECRETS)) expect(out).not.toContain(secret);
    expect(d.fetched).toHaveLength(0);
    expect(d.ran).toHaveLength(0);
  });

  it("dry run exits 1 naming missing required variables and a missing token", async () => {
    const d = deps();
    expect(
      await runPlatformCli(["railway-quant", "--dry-run"], { SOLANA_CLUSTER: "devnet" }, d.deps),
    ).toBe(1);
    const out = d.logs.join("\n");
    expect(out).toContain("token: MISSING");
    expect(out).toContain("missing required: MARKET_MAKER_KEYPAIR");
    expect(out).toContain("PYTH_API_TOKEN");
  });

  it("honours RAILWAY_QUANT_SERVICE_NAME, not the automation service name", async () => {
    const d = deps();
    await runPlatformCli(
      ["railway-quant", "--dry-run"],
      { ...FULL_ENV, RAILWAY_SERVICE_NAME: "automation", RAILWAY_QUANT_SERVICE_NAME: "quant-2" },
      d.deps,
    );
    expect(d.logs.join("\n")).toContain("service quant-2,");
  });

  it("requires the token to deploy", async () => {
    const d = deps();
    expect(
      await runPlatformCli(["railway-quant"], { ...FULL_ENV, RAILWAY_TOKEN: "" }, d.deps),
    ).toBe(1);
    expect(d.logs.join("\n")).toContain("RAILWAY_TOKEN is not set");
    expect(d.fetched).toHaveLength(0);
  });

  it("deploys the existing quant service and prints its URL", async () => {
    const d = deps();
    expect(await runPlatformCli(["railway-quant"], FULL_ENV, d.deps)).toBe(0);
    const out = d.logs.join("\n");
    expect(out).toContain("quant URL: https://quant.up.railway.app");
    expect(d.ran[0]?.join(" ")).toContain("--service quant");
    expect(d.fetched).toContain("https://quant.up.railway.app/health");
    for (const secret of Object.values(SECRETS)) expect(out).not.toContain(secret);
  });

  it("rejects unknown flags", async () => {
    expect(await runPlatformCli(["railway-quant", "--force"], FULL_ENV, deps().deps)).toBe(2);
  });
});
