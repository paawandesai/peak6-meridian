import { describe, expect, it } from "vitest";

import type { PlatformDeps } from "./platform";
import {
  deployVercel,
  ensureVercelProject,
  parseDeploymentUrl,
  type VercelOptions,
} from "./vercel";

const TOKEN = "vercel-token-SECRET";
const FAUCET = "[9,9,9,9,9,9,9]";
const env = {
  NEXT_PUBLIC_CLUSTER: "devnet",
  NEXT_PUBLIC_RPC_URL: "https://api.devnet.solana.com",
  NEXT_PUBLIC_PROGRAM_ID: "Prog1111",
  NEXT_PUBLIC_USDC_MINT: "Mint1111",
  SOLANA_CLUSTER: "devnet",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  USDC_MINT: "Mint1111",
  FAUCET_KEYPAIR: FAUCET,
};
const options: VercelOptions = {
  token: TOKEN,
  projectName: "meridian",
  env,
  repoRoot: "/repo",
};

function fakes(projectStatus: number) {
  const calls: { url: string; method: string; body: string }[] = [];
  const logs: string[] = [];
  const deps: PlatformDeps = {
    log: (line) => logs.push(line),
    sleep: async () => undefined,
    fetch: async (url, init) => {
      calls.push({ url, method: String(init.method), body: String(init.body ?? "") });
      if (url.endsWith("/v2/user")) return new Response(JSON.stringify({ user: { id: "usr_1" } }));
      if (url.endsWith("/v2/teams")) return new Response(JSON.stringify({ teams: [] }));
      if (url.includes("/v9/projects/")) {
        return new Response(JSON.stringify({ id: "prj_1" }), { status: projectStatus });
      }
      if (url.includes("/v11/projects")) return new Response(JSON.stringify({ id: "prj_new" }));
      return new Response("{}");
    },
  };
  return { deps, calls, logs };
}

describe("deployVercel", () => {
  it("creates a missing project by name, upserts env and deploys with token in env only", async () => {
    const { deps, calls, logs } = fakes(404);
    let runArgs: readonly string[] = [];
    let runEnv: NodeJS.ProcessEnv = {};
    const result = await deployVercel(deps, options, async (_c, args, o) => {
      runArgs = args;
      runEnv = o.env;
      return {
        stdout: "Inspect: https://vercel.com/x\nProduction: https://meridian-abc.vercel.app\n",
      };
    });
    expect(result.url).toBe("https://meridian-abc.vercel.app");
    expect(calls.some((c) => c.url.includes("/v11/projects") && c.method === "POST")).toBe(true);
    const envCall = calls.find((c) => c.url.includes("/prj_new/env"));
    const sent = JSON.parse(envCall?.body ?? "[]") as { key: string; type: string }[];
    expect(sent.find((e) => e.key === "FAUCET_KEYPAIR")?.type).toBe("encrypted");
    expect(sent.find((e) => e.key === "NEXT_PUBLIC_CLUSTER")?.type).toBe("plain");
    expect(runArgs.join(" ")).toContain("vercel@63.1.0 deploy --prod --yes");
    expect(runArgs.join(" ")).not.toContain(TOKEN);
    expect(runEnv.VERCEL_TOKEN).toBe(TOKEN);
    expect(runEnv.VERCEL_PROJECT_ID).toBe("prj_new");
    expect(runEnv.VERCEL_ORG_ID).toBe("usr_1");
    expect(runEnv.FAUCET_KEYPAIR).toBeUndefined();
    expect(runEnv.RAILWAY_TOKEN).toBeUndefined();
    const output = logs.join("\n");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(FAUCET);
    expect(output).toContain("FAUCET_KEYPAIR");
  });

  it("reuses an existing project without creating one", async () => {
    const { deps, calls } = fakes(200);
    await deployVercel(deps, options, async () => ({ stdout: "https://a.vercel.app" }));
    expect(calls.some((c) => c.url.includes("/v11/projects"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/prj_1/env"))).toBe(true);
  });

  it("uses the team id as scope when given", async () => {
    const { deps, calls } = fakes(200);
    await deployVercel(deps, { ...options, teamId: "team_9" }, async () => ({
      stdout: "https://a.vercel.app",
    }));
    expect(calls.some((c) => c.url.endsWith("/v2/user"))).toBe(false);
    expect(calls.every((c) => c.url.includes("teamId=team_9"))).toBe(true);
  });

  it("refuses before any network call when required variables are missing", async () => {
    const { deps, calls } = fakes(200);
    await expect(
      deployVercel(deps, { ...options, env: { ...env, FAUCET_KEYPAIR: "" } }, async () => ({
        stdout: "",
      })),
    ).rejects.toThrow(/missing required variables: FAUCET_KEYPAIR/);
    expect(calls).toHaveLength(0);
  });

  it("redacts the token from a failing CLI", async () => {
    const { deps } = fakes(200);
    await expect(
      deployVercel(deps, options, async () => {
        throw new Error(`vercel failed using ${TOKEN}`);
      }),
    ).rejects.toThrow(/using \*\*\*/);
  });

  it("surfaces API errors by status only", async () => {
    const { deps } = fakes(500);
    await expect(deployVercel(deps, options, async () => ({ stdout: "" }))).rejects.toThrow(
      /looking up project failed \(status 500\)/,
    );
  });
});

describe("parseDeploymentUrl", () => {
  it("takes the last URL and fails when none is printed", () => {
    expect(parseDeploymentUrl("a https://x.test b\nhttps://y.test")).toBe("https://y.test");
    expect(() => parseDeploymentUrl("nothing")).toThrow(/no deployment URL/);
  });

  it("reuses a project found under one of the token's teams instead of creating one", async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/v2/user")) return new Response(JSON.stringify({ user: { id: "usr_1" } }));
      if (url.endsWith("/v2/teams"))
        return new Response(JSON.stringify({ teams: [{ id: "team_1" }] }));
      if (url.includes("/v9/projects/") && url.includes("teamId=team_1")) {
        return new Response(JSON.stringify({ id: "prj_team" }));
      }
      if (url.includes("/v9/projects/")) return new Response("{}", { status: 404 });
      return new Response("{}", { status: 400 });
    };
    const deps: PlatformDeps = { fetch, log: () => undefined, sleep: async () => undefined };
    const got = await ensureVercelProject(deps, options, []);
    expect(got).toEqual({ id: "prj_team", orgId: "team_1", created: false, teamId: "team_1" });
    expect(calls.some((c) => c.includes("/v11/projects"))).toBe(false);
  });
});
