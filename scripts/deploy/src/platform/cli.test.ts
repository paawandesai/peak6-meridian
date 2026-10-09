import { describe, expect, it } from "vitest";

import { runPlatformCli, type CliDeps } from "./cli";

function deps(): { deps: CliDeps; logs: string[]; fetched: string[] } {
  const logs: string[] = [];
  const fetched: string[] = [];
  return {
    logs,
    fetched,
    deps: {
      repoRoot: "/repo",
      log: (line) => logs.push(line),
      sleep: async () => undefined,
      fetch: async (url) => {
        fetched.push(url);
        return new Response("{}");
      },
      run: async () => ({ stdout: "" }),
    },
  };
}

describe("runPlatformCli", () => {
  it("rejects unknown targets and flags with exit 2", async () => {
    expect(await runPlatformCli([], {}, deps().deps)).toBe(2);
    expect(await runPlatformCli(["heroku"], {}, deps().deps)).toBe(2);
    expect(await runPlatformCli(["vercel", "--force"], {}, deps().deps)).toBe(2);
  });

  it("dry run lists missing variables by name, makes no network call, exits 1", async () => {
    const d = deps();
    const code = await runPlatformCli(
      ["vercel", "--dry-run"],
      { VERCEL_TOKEN: "tok-secret-1" },
      d.deps,
    );
    expect(code).toBe(1);
    const out = d.logs.join("\n");
    expect(out).toContain("missing required: NEXT_PUBLIC_CLUSTER");
    expect(out).toContain("token: present");
    expect(out).not.toContain("tok-secret-1");
    expect(d.fetched).toHaveLength(0);
  });

  it("requires the token to deploy", async () => {
    const d = deps();
    expect(await runPlatformCli(["railway"], {}, d.deps)).toBe(1);
    expect(await runPlatformCli(["vercel"], {}, d.deps)).toBe(1);
    expect(d.logs.join("\n")).toContain("RAILWAY_TOKEN is not set");
  });

  it("dry run of railway exits 0 when everything is present", async () => {
    const d = deps();
    const env = {
      RAILWAY_TOKEN: "tok-secret-1",
      SOLANA_CLUSTER: "devnet",
      SOLANA_RPC_URL: "https://x.test",
      MERIDIAN_PROGRAM_ID: "P",
      AUTOMATION_KEYPAIR: "[1]",
      SERVICE_TOKEN: "s",
      TIINGO_API_KEY: "t",
      TWELVEDATA_API_KEY: "t",
    };
    expect(await runPlatformCli(["railway", "--dry-run"], env, d.deps)).toBe(0);
  });

  it("deploys vercel through the injected fetch and runner", async () => {
    const logs: string[] = [];
    const env = {
      VERCEL_TOKEN: "tok-secret-1",
      NEXT_PUBLIC_CLUSTER: "devnet",
      NEXT_PUBLIC_RPC_URL: "https://x.test",
      NEXT_PUBLIC_PROGRAM_ID: "P",
      NEXT_PUBLIC_USDC_MINT: "M",
      SOLANA_CLUSTER: "devnet",
      SOLANA_RPC_URL: "https://x.test",
      USDC_MINT: "M",
      FAUCET_KEYPAIR: "[1]",
    };
    const code = await runPlatformCli(["vercel"], env, {
      repoRoot: "/repo",
      log: (l) => logs.push(l),
      sleep: async () => undefined,
      fetch: async (url) =>
        new Response(
          JSON.stringify(url.endsWith("/v2/user") ? { user: { id: "u" } } : { id: "prj" }),
        ),
      run: async () => ({ stdout: "https://a.vercel.app" }),
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("app URL: https://a.vercel.app");
  });
});
