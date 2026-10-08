<!-- OWNER: operator. -->
# Meridian

Binary 0DTE outcome markets on the MAG7 stocks, on Solana devnet. Each contract asks "Will TICKER close at or above STRIKE today?" and pays $1.00 test-USDC to YES or NO. Markets are created every trading morning, trade on an on-chain order book, settle from an oracle after the 4:00 PM ET close, and winners redeem. Devnet only; no real funds.

Start here: [docs/brief.md](docs/brief.md) · [docs/architecture.md](docs/architecture.md) · [docs/domain.md](docs/domain.md) · [docs/status.md](docs/status.md)

## Quickstart (local)
Linux, from the repo root:
```bash
make toolchain        # once: Rust, Agave CLI, Anchor 0.31.1, Node 22, pnpm, uv
cp .env.example .env
make install
make dev              # local validator + program + seeded markets + app on http://localhost:3000
make e2e              # scripted full lifecycle: create → mint → trade (4 paths) → settle → redeem
```
Commands and conventions: [CLAUDE.md](CLAUDE.md). Environment variables: [docs/environment.md](docs/environment.md).

## Devnet
- **Program ID (declared):** `3RovidBTwYzUfhniunxsUgnLzsbWz6qt3PGpvD23HDZq` (the key behind it is held by the human, OQ-5). The first live run writes it, with the mint and Config PDA, to `deployments/devnet.json`.
- **Test-USDC mint:** _not created yet._ The first live `make deploy-devnet` run creates it (6 decimals, mint authority = the faucet key) and writes its address to `deployments/devnet.json` and here.
- **Frontend URL, how to get test-USDC:** _filled in when the app is deployed (M2-11; the `deploy:vercel` job prints the URL)._
- **Automation service (Railway):** `/health` needs `Authorization: Bearer <SERVICE_TOKEN>`; the `deploy:railway` job prints its URL.
- Deploys run from CI on `main` (`make deploy-vercel`, `make deploy-railway`; `DEPLOY_ARGS=--dry-run` lists the variables each target needs, names only).

Deploy (idempotent, refuses any cluster whose genesis hash is not devnet; needs the keypairs from OQ-5, see [docs/environment.md](docs/environment.md#devnet-deploy)):

```sh
make deploy-devnet                                            # program, test-USDC mint, config
make deploy-devnet DEPLOY_ARGS="--feeds deployments/feeds.devnet.json"   # pin real Switchboard feeds
```

## Demo
_Filled in as milestones ship._
- **M1:** _pending_
- **M2:** _pending_
- **M3:** _pending_
- **M4:** _pending_

## Risks and limitations
See docs/risks.md (written in M4). No regulatory or compliance claims are made.
