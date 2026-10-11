<!-- OWNER: shared. Operator may update to match reality; every change is logged in docs/decisions.md. -->
# Environment

## Where secrets live
- **Local:** `.env` at the repo root (gitignored; copy from `.env.example`). Keypairs as files under `~/.config/meridian/` (never inside the repo).
- **CI:** GitLab CI/CD variables, **masked and protected**: only deploy tokens (`VERCEL_*`, `RAILWAY_TOKEN`). CI never needs data-API or Anthropic keys (tests mock them).
- **Deployed:** Railway service variables (automation, quant, ops-agent); Vercel project env (app). Only the human creates or rotates real secrets (Tier 3).

## Variables
| Name | Used by | Purpose | Req? | Example |
|---|---|---|---|---|
| `SOLANA_CLUSTER` | all | `localnet` or `devnet` | yes | `localnet` |
| `SOLANA_RPC_URL` | all | RPC HTTP endpoint (server-only via P0-5 proxy; defaults to public devnet) | yes | `http://127.0.0.1:8899` |
| `SOLANA_RPC_URL_FALLBACK` | app server (P0-5) | Optional fallback RPC; rotates to this on 429/5xx from primary | no | `https://devnet.helius-rpc.com` |
| `SOLANA_WS_URL` | app, automation, quant | RPC websocket | yes | `ws://127.0.0.1:8900` |
| `MERIDIAN_PROGRAM_ID` | all | Deployed program ID | yes | `Merid1an11111111111111111111111111111111111` |
| `USDC_MINT` | all | Test-USDC mint | yes | `Usdc111111111111111111111111111111111111111` |
| `PROGRAM_KEYPAIR_PATH` | scripts | Program ID keypair file for first devnet deploy (never committed) | M2 | `~/.config/meridian/program.json` |
| `ADMIN_KEYPAIR_PATH` | scripts | Admin keypair file (deploy/config/override scripts) | scripts only | `~/.config/meridian/admin.json` |
| `PROGRAM_KEYPAIR_PATH` | scripts | Keypair FILE for the declared program ID; used to deploy (path only, never committed) | deploy | `~/.config/meridian/program.json` |
| `FAUCET_PUBKEY` | scripts, app (server) | Public key of the faucet; becomes the test-USDC mint authority (the script never reads `FAUCET_KEYPAIR`) | deploy | `<pubkey>` |
| `AUTOMATION_PUBKEY` | scripts | Public key of the automation authority set in Config (the script never reads `AUTOMATION_KEYPAIR`) | deploy | `<pubkey>` |
| `AUTOMATION_KEYPAIR` | automation | Automation authority secret key (JSON array) | yes (automation) | `[1,2,3,...]` |
| `MARKET_MAKER_KEYPAIR` | quant | Market-maker wallet secret key (JSON array) | M3 | `[1,2,3,...]` |
| `FAUCET_KEYPAIR` | app (server), scripts (lifecycle fallback signing only) | Test-USDC mint authority for the faucet (JSON array) | M2 | `[1,2,3,...]` |
| `AUTOMATION_PUBKEY` | scripts (deploy) | Automation authority public key written to Config (no secret needed by deploy) | M2 | `<base58 pubkey>` |
| `FAUCET_PUBKEY` | scripts (deploy) | Faucet public key used as test-USDC mint authority (no secret needed by deploy) | M2 | `<base58 pubkey>` |
| `FAUCET_MIN_LAMPORTS` | app (server) | Faucet key balance floor in integer lamports; below it the faucet returns 503 and alerts. A claimant with under 0.005 SOL also gets 0.01 SOL for fees in the claim transaction, only while the faucet stays at or above this floor afterwards (otherwise test-USDC only, with `fee_sol_status: "faucet_low"` and an alert) | no (default 100000000) | `100000000` |
| `FAUCET_ALERT_COOLDOWN_SEC` | app (server) | Per-instance cooldown between low-balance alerts | no (default 3600) | `3600` |
| `FAUCET_AMOUNT_USDC` | app (server) | Faucet amount per claim | no (default 1000) | `1000` |
| `MERIDIAN_DEVNET_IDL` | tests | Path to the `make build-devnet` IDL (`target/idl/meridian.json`) for the AB-22 check; the M2-01 test sets it itself and fails if the file is missing | tests only | `target/idl/meridian.json` |
| `SWITCHBOARD_QUEUE` | automation, scripts | Switchboard devnet queue pubkey | devnet | `<queue pubkey>` |
| `SWITCHBOARD_FEEDS_JSON` | automation, scripts | Feed pubkeys per ticker and source | devnet | `{"AAPL":["<tiingo feed>","<twelvedata feed>"],...}` |
| `TIINGO_API_KEY` | automation, app server, quant, ops-agent, feed jobs | Tiingo API | devnet | `test-tiingo-key` |
| `TWELVEDATA_API_KEY` | same | Twelve Data API | devnet | `test-twelvedata-key` |
| `FINNHUB_API_KEY` | app server, quant, ops-agent | Finnhub live quotes | no | `test-finnhub-key` |
| `PYTH_API_TOKEN` | automation, quant, app (server) | Pyth Pro (Lazer) API (server-only secret, never in tests/logs/commits). Quant: primary spot source (one `latest_price` call for all 7 tickers per 5 s) and daily-closes fallback; without it quant uses Finnhub only | M3 (quant: recommended) | `test-pyth-token` |
| `PYTH_SETTLEMENT_ENABLED` | automation (service and `settle-now`) | `true` settles from Pyth Lazer's signed close (D-055; docs/runbook.md § Pyth settlement); anything else keeps the default path. When `true`, `PYTH_API_TOKEN` is required | no (default `false`) | `false` |
| `PYTH_LAZER_URL` | automation | Pyth Lazer REST base URL for signed closes | no (default `https://pyth-lazer.dourolabs.app`) | `https://pyth-lazer.dourolabs.app` |
| `ANTHROPIC_API_KEY` | ops-agent | Claude API | M3 | `sk-ant-test-placeholder` |
| `OPS_AGENT_MODEL` | ops-agent | Model ID | no | `claude-sonnet-5-5` |
| `OPS_AGENT_BUDGET_USD` | ops-agent | Hard spend cap; agent refuses calls once reached | no (default 20) | `20` |
| `SERVICE_TOKEN` | app, automation, quant, ops-agent | Bearer token for internal HTTP calls | yes (services) | `local-dev-token` |
| `QUANT_URL` / `OPS_AGENT_URL` | app, automation | Internal service URLs (production `QUANT_URL`: the Railway `quant` service URL printed by `make deploy-quant`) | M3 | `http://127.0.0.1:4100` |
| `QUANT_HOST` / `QUANT_PORT` | quant | HTTP bind address; on Railway the start command sets `QUANT_PORT` from Railway's `PORT` | no (default `0.0.0.0` / `4100`) | `4100` |
| `MERIDIAN_DEMO_ALLOW_STALE_SPOT` | quant | Devnet demo only: price and quote from the last spot after hours (see `meridian_quant/demo.py`) | no | `1` |
| `AUTOMATION_URL` | app (server) | Automation service base URL; `/api/market-open-times` proxies its `GET /markets` open-time index (P1-4). Unset: the UI shows "Open time unavailable" | no | `http://127.0.0.1:4000` |
| `ALERT_WEBHOOK_URL` | automation, ops-agent, app (server) | POST JSON alerts (Discord/Slack-compatible) | no | `https://example.invalid/webhook` |
| `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | CI deploy job only | Deploy the app with the Vercel CLI (IDs come from `vercel link`) | M2 | `test-vercel-token` |
| `RAILWAY_TOKEN` | CI deploy job only | Railway project token for deploying services | M2 | `test-railway-token` |
| `FAULT_INJECT_SOURCE` | local demo only | Make one fixture source report a bad close; refused unless `SOLANA_CLUSTER=localnet` | no | `twelvedata` |
| `NEXT_PUBLIC_CLUSTER` / `NEXT_PUBLIC_PROGRAM_ID` / `NEXT_PUBLIC_USDC_MINT` | app (browser) | Public config only (never secrets) | yes | same as above |
| `NEXT_PUBLIC_RPC_URL` | app (browser) | Client RPC endpoint; **production: points to `/api/rpc` proxy (P0-5), not directly to provider** | yes | `https://<app-domain>/api/rpc` |
On-chain parameters (staleness, spread, override delay) are in the Config account, not env (see [domain.md](domain.md#settlement-rules)).

## Devnet deploy
`make deploy-devnet` (M2-01) deploys the **devnet** build (no test oracle), creates the test-USDC mint and initialises the Config, in that order, and is safe to re-run.
- Environment: `SOLANA_RPC_URL`, `SOLANA_CLUSTER` (`devnet`, or `localnet` with a loopback URL), `ADMIN_KEYPAIR_PATH` (fee payer and upgrade authority), `PROGRAM_KEYPAIR_PATH`, `FAUCET_PUBKEY`, `AUTOMATION_PUBKEY`; optional `MERIDIAN_PROGRAM_ID`, `USDC_MINT`, and `SWITCHBOARD_QUEUE` (needed with `--feeds` to verify feed hashes). Only public keys and key **file paths** are read: never `FAUCET_KEYPAIR` or `AUTOMATION_KEYPAIR`.
- Guards before any transaction: the RPC's genesis hash must be devnet's (hostname is irrelevant; mainnet, testnet, unknown and unreachable RPCs are refused); the program keypair must equal `declare_id!`, the built IDL address and `MERIDIAN_PROGRAM_ID` when set.
- Output: `deployments/devnet.json` (public keys only; `--out <file>` to write elsewhere). On a re-run the on-chain Config, not the record, is the source of truth.
- `--feeds <file>` pins real Switchboard feeds (`{ "AAPL": [{pubkey, hash}, {pubkey, hash}], ... }`), checked against `oracle/feeds/*` and for Switchboard ownership before anything is sent. Without it, feed fields are never touched.

## Quant on Railway (M3-08b)
`make deploy-quant` deploys the quant service (`python -m meridian_quant.mm.main`: `GET /fair-values` with bearer `SERVICE_TOKEN`, unauthenticated `GET /health`, and the market maker, all in one process) to Railway as the service `quant`. The operator runs it by hand; it is not part of CI. `make deploy-quant DEPLOY_ARGS=--dry-run` prints the service, config file, health path and the variable names (present or missing), with no network call.
- Token: `RAILWAY_TOKEN` (project or account token). Optional: `RAILWAY_PROJECT_NAME` / `DEPLOY_PROJECT_NAME` (default `meridian`), `RAILWAY_QUANT_SERVICE_NAME` (default `quant`).
- Required variables (set on the service; values never printed): `MARKET_MAKER_KEYPAIR` (secret), `MERIDIAN_PROGRAM_ID`, `USDC_MINT`, `SERVICE_TOKEN` (secret), `FINNHUB_API_KEY` (secret), `TIINGO_API_KEY` (secret), `SOLANA_RPC_URL` (secret: a provider URL carries its key), `SOLANA_CLUSTER`.
- Optional: `PYTH_API_TOKEN` (secret; recommended, the primary spot source), `MERIDIAN_DEMO_ALLOW_STALE_SPOT`, `MERIDIAN_DEVNET_RPC_URL` (secret; takes precedence over `SOLANA_RPC_URL`), `SOLANA_WS_URL` (secret).
- The command also sets `RAILPACK_CONFIG_FILE=services/quant/railpack.json`: the repo root holds `Cargo.toml`, so Railpack would otherwise build a Rust image. Build and start come from `services/quant/railway.json` (locked `uv sync` of `meridian_quant` only; `QUANT_PORT=$PORT`; health check `/health`; restart on failure).
- After the first deploy, set the Vercel app's `QUANT_URL` to the printed URL and its `SERVICE_TOKEN` to the same value, so `/api/fair-values` reaches the service.
- Spot and fair-value caching: spots are fetched at most once per ticker per 5 s (Pyth Pro for all tickers in one call, Finnhub per ticker as the fallback), and fair values are recomputed every 1.5 s in the background; every `/fair-values` request and the market maker read that cache. A value whose refresh failed, or that is more than 30 s old, is served with `stale: true` (and the market maker pulls its quotes); a market that never had a value is left out.

## Local services and ports
| Service | Port | Start |
|---|---|---|
| `solana-test-validator` | 8899 (RPC), 8900 (WS) | `make dev` / `make e2e` |
| app (Next.js) | 3000 | `make dev` |
| automation health | 4000 | `make dev` |
| quant | 4100 | `make dev` (M3) |
| ops-agent | 4200 | `make dev` (M3) |

## Seed and test data
- `make dev` deploys the **local** build (with test oracle), creates test-USDC, initializes Config with local feeds, creates today's markets for all 7 tickers from fixture previous closes (`tests/fixtures/prev_closes.json`), and funds two local wallets (`trader-a`, `trader-b`) with 10,000 test-USDC.
- Fixture data-API responses live in `tests/fixtures/` (recorded shapes, made-up prices). Tests and local mode read only these.
- Devnet: the faucet funds any wallet; the market maker seeds liquidity (M3).

## Run the full system locally
1. `make toolchain` (once), `cp .env.example .env`.
2. `make install`
3. `make dev` → open http://localhost:3000, import a local trader keypair into Phantom (or use the wallet-adapter test wallet), trade.
4. `make e2e` runs the scripted lifecycle headlessly.
