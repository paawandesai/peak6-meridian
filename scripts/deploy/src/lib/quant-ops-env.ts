/**
 * Environment specs for quant and ops-agent Railway services (M3-08). Extends the M2-11 platform
 * deployment pattern. These specs are used by the deploy commands to collect and set variables
 * from GitLab CI protected variables, never committed to the repo.
 */

/** Environment spec type from platform.ts (M2-11). */
export type EnvSpec = {
  readonly required: readonly string[];
  readonly optional: readonly string[];
};

/** Variables the quant service needs on Railway (M3-01 fair values + M3-02 market maker). */
export const QUANT_ENV: EnvSpec = {
  required: [
    "SOLANA_CLUSTER",
    "SOLANA_RPC_URL",
    "MERIDIAN_PROGRAM_ID",
    "USDC_MINT",
    "MARKET_MAKER_KEYPAIR",
    "SERVICE_TOKEN",
    "TIINGO_API_KEY",
    "TWELVEDATA_API_KEY",
  ],
  optional: ["FINNHUB_API_KEY", "ALERT_WEBHOOK_URL"],
};

/** Variables the ops-agent service needs on Railway (M3-05 investigation + override drafts). */
export const OPS_AGENT_ENV: EnvSpec = {
  required: [
    "SOLANA_CLUSTER",
    "SOLANA_RPC_URL",
    "MERIDIAN_PROGRAM_ID",
    "USDC_MINT",
    "SERVICE_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPS_AGENT_MODEL",
    "OPS_AGENT_BUDGET_USD",
    "TIINGO_API_KEY",
    "TWELVEDATA_API_KEY",
  ],
  optional: ["FINNHUB_API_KEY", "ALERT_WEBHOOK_URL"],
};

/** Railway service config file paths. */
export const QUANT_CONFIG_FILE = "services/quant/railway.json";
export const OPS_AGENT_CONFIG_FILE = "services/ops-agent/railway.json";
