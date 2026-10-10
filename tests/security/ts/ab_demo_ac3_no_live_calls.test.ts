/**
 * M3-07 AC3: Default demo-ops makes no live API calls.
 *
 * Verifies that the demo default path (ENABLE_LIVE_LLM unset) actually uses FixtureTools
 * and never constructs HttpSourceTools or AnthropicLLM. Checks both demo-ops.ts (which
 * must not call live APIs itself) and ops-agent-demo.py (which must wire FixtureTools).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const DEMO_OPS_PATH = join(__dirname, "../../../scripts/demo-ops.ts");
const OPS_AGENT_DEMO_PATH = join(__dirname, "../../../scripts/lib/demo/ops-agent-demo.py");

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

describe("ops-agent-demo.py AC3: FixtureTools only, no live clients", () => {
  const opsAgentDemoSource = readFileSync(OPS_AGENT_DEMO_PATH, "utf-8");

  it("imports and constructs FixtureTools with recorded data", () => {
    // AC3: demo launcher must use FixtureTools, not HttpSourceTools
    expect(opsAgentDemoSource).toContain("from meridian_ops_agent.tools import FixtureTools");
    expect(opsAgentDemoSource).toContain("FixtureTools(reports");
    expect(opsAgentDemoSource).toContain("fixture_data.get");
  });

  it("does NOT import or construct HttpSourceTools", () => {
    // AC3: no live Tiingo/TwelveData clients (HttpSourceTools may appear in docstrings)
    expect(opsAgentDemoSource).not.toContain(
      "from meridian_ops_agent.tools import HttpSourceTools",
    );
    expect(opsAgentDemoSource).not.toContain("HttpSourceTools(");
    expect(opsAgentDemoSource).not.toContain("tiingo_key");
    expect(opsAgentDemoSource).not.toContain("twelvedata_key");
  });

  it("does NOT import or construct AnthropicLLM", () => {
    // AC3: deterministic fallback only (llm=None), no live Claude calls
    expect(opsAgentDemoSource).not.toContain("AnthropicLLM");
    expect(opsAgentDemoSource).not.toContain("LoggedLLM");
    expect(opsAgentDemoSource).toContain("llm = None");
    expect(opsAgentDemoSource).toContain("Deterministic fallback only");
  });

  it("wires OpsApp with FixtureTools factory and llm=None", () => {
    // AC3: OpsApp must receive tools factory that returns FixtureTools, and llm=None
    expect(opsAgentDemoSource).toContain("def tools_factory");
    expect(opsAgentDemoSource).toContain("return FixtureTools");
    expect(opsAgentDemoSource).toContain("OpsApp(");
    expect(opsAgentDemoSource).toContain("tools=tools_factory");
    expect(opsAgentDemoSource).toContain("llm=llm");
  });
});
