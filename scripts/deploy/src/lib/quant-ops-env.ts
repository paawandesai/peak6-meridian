/**
 * Environment specs for quant and ops-agent Railway services (M3-08). Extends the M2-11 platform
 * deployment pattern. These specs are used by the deploy commands to collect and set variables
 * from GitLab CI protected variables, never committed to the repo.
 *
 * DEPLOYMENT: Once M2-11 (platform-cli, railway.ts) and M3-01/M3-02/M3-05 (server modules) merge,
 * the .gitlab-ci.yml deploy jobs will use M2-11's deployRailway() with these env specs and the
 * railway.json configs. The services start via `uv run --frozen --package <name> python -m <name>.server`
 * and expose GET /health (with SERVICE_TOKEN bearer), GET /fair-values (quant), POST /incidents
 * and GET /drafts (ops-agent). This MR provides the Railway config; deployment happens after deps merge.
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
