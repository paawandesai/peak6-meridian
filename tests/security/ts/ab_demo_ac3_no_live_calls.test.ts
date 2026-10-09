/**
 * M3-07 AC3: Default demo-ops makes no live API calls.
 *
 * Verifies that demo-ops.ts source code does not construct Anthropic/Tiingo/TwelveData
 * clients. The demo calls ops-agent (which is started externally with or without
 * OPS_AGENT_LLM), but demo-ops itself must not make live API calls.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const DEMO_OPS_PATH = join(__dirname, "../../../scripts/demo-ops.ts");

describe("demo-ops AC3: no live API client construction", () => {
  const demoOpsSource = readFileSync(DEMO_OPS_PATH, "utf-8");

  it("does not import or construct Anthropic client", () => {
    // Fail if the demo script directly imports or constructs an Anthropic client
    expect(demoOpsSource).not.toContain('from "@anthropic-ai/sdk"');
    expect(demoOpsSource).not.toContain('from "anthropic"');
    expect(demoOpsSource).not.toContain("new Anthropic(");
    expect(demoOpsSource).not.toContain("anthropic.Anthropic(");
  });

  it("does not call api.tiingo.com directly", () => {
    // Demo-ops should never call Tiingo API directly
    // It only calls the ops-agent API, which handles data providers
    expect(demoOpsSource).not.toContain("api.tiingo.com");
  });

  it("does not call api.twelvedata.com directly", () => {
    // Demo-ops should never call TwelveData API directly
    expect(demoOpsSource).not.toContain("api.twelvedata.com");
  });

  it("only makes HTTP fetch calls to OPS_AGENT_URL", () => {
    // Find all global fetch() calls (not .fetch() which is Anchor account fetch)
    const fetchCalls = demoOpsSource.match(/[^.]fetch\([^)]+\)/g) || [];

    // Filter out false positives like "await fetch" matching ".fetch"
    const httpFetchCalls = fetchCalls.filter((call) => !call.startsWith("."));

    // All HTTP fetch calls should be to OPS_AGENT_URL (the ops-agent service)
    expect(httpFetchCalls.length).toBeGreaterThan(0); // Ensure we found some
    for (const call of httpFetchCalls) {
      expect(call).toContain("OPS_AGENT_URL");
      // Should not contain hardcoded API URLs
      expect(call).not.toMatch(/https?:\/\/api\.(tiingo|twelvedata|anthropic)\.com/);
    }
  });

  it("documents ENABLE_LIVE_LLM as controlling ops-agent startup", () => {
    // AC3: ENABLE_LIVE_LLM controls how ops-agent is started (with or without OPS_AGENT_LLM)
    // Demo-ops logs this but doesn't start ops-agent itself
    expect(demoOpsSource).toContain("ENABLE_LIVE_LLM");
    expect(demoOpsSource).toContain("deterministic fallback");
  });
});
