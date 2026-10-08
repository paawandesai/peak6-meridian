import { describe, expect, it } from "vitest";

import { OPS_AGENT_ENV, QUANT_ENV } from "./quant-ops-env";

describe("QUANT_ENV", () => {
  it("includes the market-maker keypair and data provider keys", () => {
    expect(QUANT_ENV.required).toContain("MARKET_MAKER_KEYPAIR");
    expect(QUANT_ENV.required).toContain("SERVICE_TOKEN");
    expect(QUANT_ENV.required).toContain("TIINGO_API_KEY");
    expect(QUANT_ENV.required).toContain("TWELVEDATA_API_KEY");
    expect(QUANT_ENV.required).toContain("SOLANA_RPC_URL");
    expect(QUANT_ENV.required).toContain("MERIDIAN_PROGRAM_ID");
  });

  it("does not list the Anthropic API key (quant has no LLM)", () => {
    expect(QUANT_ENV.required).not.toContain("ANTHROPIC_API_KEY");
    expect(QUANT_ENV.optional).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("OPS_AGENT_ENV", () => {
  it("includes the Anthropic API key, model and budget for LLM calls", () => {
    expect(OPS_AGENT_ENV.required).toContain("ANTHROPIC_API_KEY");
    expect(OPS_AGENT_ENV.required).toContain("OPS_AGENT_MODEL");
    expect(OPS_AGENT_ENV.required).toContain("OPS_AGENT_BUDGET_USD");
  });

  it("includes data provider keys for source-checking", () => {
    expect(OPS_AGENT_ENV.required).toContain("TIINGO_API_KEY");
    expect(OPS_AGENT_ENV.required).toContain("TWELVEDATA_API_KEY");
  });

  it("does not include the market-maker keypair (ops-agent never signs)", () => {
    expect(OPS_AGENT_ENV.required).not.toContain("MARKET_MAKER_KEYPAIR");
    expect(OPS_AGENT_ENV.optional).not.toContain("MARKET_MAKER_KEYPAIR");
  });

  it("includes read-only Solana access (no signing keypair)", () => {
    expect(OPS_AGENT_ENV.required).toContain("SOLANA_RPC_URL");
    expect(OPS_AGENT_ENV.required).toContain("MERIDIAN_PROGRAM_ID");
  });
});
