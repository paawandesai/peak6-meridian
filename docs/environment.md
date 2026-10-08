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
| `SOLANA_RPC_URL` | all | RPC HTTP endpoint | yes | `http://127.0.0.1:8899` |
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
| `FAUCET_MIN_LAMPORTS` | app (server) | Faucet key balance floor in integer lamports; below it the faucet returns 503 and alerts | no (default 100000000) | `100000000` |
| `FAUCET_ALERT_COOLDOWN_SEC` | app (server) | Per-instance cooldown between low-balance alerts | no (default 3600) | `3600` |
| `FAUCET_AMOUNT_USDC` | app (server) | Faucet amount per claim | no (default 1000) | `1000` |
| `MERIDIAN_DEVNET_IDL` | tests | Path to the `make build-devnet` IDL (`target/idl/meridian.json`) for the AB-22 check; the M2-01 test sets it itself and fails if the file is missing | tests only | `target/idl/meridian.json` |
| `SWITCHBOARD_QUEUE` | automation, scripts | Switchboard devnet queue pubkey | devnet | `<queue pubkey>` |
| `SWITCHBOARD_FEEDS_JSON` | automation, scripts | Feed pubkeys per ticker and source | devnet | `{"AAPL":["<tiingo feed>","<twelvedata feed>"],...}` |
| `TIINGO_API_KEY` | automation, app server, quant, ops-agent, feed jobs | Tiingo API | devnet | `test-tiingo-key` |
| `TWELVEDATA_API_KEY` | same | Twelve Data API | devnet | `test-twelvedata-key` |
| `FINNHUB_API_KEY` | app server, quant, ops-agent | Finnhub live quotes | no | `test-finnhub-key` |
| `ANTHROPIC_API_KEY` | ops-agent | Claude API | M3 | `sk-ant-test-placeholder` |
| `OPS_AGENT_MODEL` | ops-agent | Model ID | no | `claude-sonnet-5-5` |
| `OPS_AGENT_BUDGET_USD` | ops-agent | Hard spend cap; agent refuses calls once reached | no (default 20) | `20` |
| `SERVICE_TOKEN` | app, automation, quant, ops-agent | Bearer token for internal HTTP calls | yes (services) | `local-dev-token` |
| `QUANT_URL` / `OPS_AGENT_URL` | app, automation | Internal service URLs | M3 | `http://127.0.0.1:4100` |
| `ALERT_WEBHOOK_URL` | automation, ops-agent, app (server) | POST JSON alerts (Discord/Slack-compatible) | no | `https://example.invalid/webhook` |
| `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | CI deploy job only | Deploy the app with the Vercel CLI (IDs come from `vercel link`) | M2 | `test-vercel-token` |
| `RAILWAY_TOKEN` | CI deploy job only | Railway project token for deploying services | M2 | `test-railway-token` |
| `FAULT_INJECT_SOURCE` | local demo only | Make one fixture source report a bad close; refused unless `SOLANA_CLUSTER=localnet` | no | `twelvedata` |
| `NEXT_PUBLIC_CLUSTER` / `NEXT_PUBLIC_RPC_URL` / `NEXT_PUBLIC_PROGRAM_ID` / `NEXT_PUBLIC_USDC_MINT` | app (browser) | Public config only (never secrets) | yes | same as above |
On-chain parameters (staleness, spread, override delay) are in the Config account, not env (see [domain.md](domain.md#settlement-rules)).

## Devnet deploy
`make deploy-devnet` (M2-01) deploys the **devnet** build (no test oracle), creates the test-USDC mint and initialises the Config, in that order, and is safe to re-run.
- Environment: `SOLANA_RPC_URL`, `SOLANA_CLUSTER` (`devnet`, or `localnet` with a loopback URL), `ADMIN_KEYPAIR_PATH` (fee payer and upgrade authority), `PROGRAM_KEYPAIR_PATH`, `FAUCET_PUBKEY`, `AUTOMATION_PUBKEY`; optional `MERIDIAN_PROGRAM_ID`, `USDC_MINT`, and `SWITCHBOARD_QUEUE` (needed with `--feeds` to verify feed hashes). Only public keys and key **file paths** are read: never `FAUCET_KEYPAIR` or `AUTOMATION_KEYPAIR`.
- Guards before any transaction: the RPC's genesis hash must be devnet's (hostname is irrelevant; mainnet, testnet, unknown and unreachable RPCs are refused); the program keypair must equal `declare_id!`, the built IDL address and `MERIDIAN_PROGRAM_ID` when set.
- Output: `deployments/devnet.json` (public keys only; `--out <file>` to write elsewhere). On a re-run the on-chain Config, not the record, is the source of truth.
- `--feeds <file>` pins real Switchboard feeds (`{ "AAPL": [{pubkey, hash}, {pubkey, hash}], ... }`), checked against `oracle/feeds/*` and for Switchboard ownership before anything is sent. Without it, feed fields are never touched.

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
