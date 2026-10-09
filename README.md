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
- **Frontend URL, how to get test-USDC:** _filled in when the app is deployed (M2)._

Deploy (idempotent, refuses any cluster whose genesis hash is not devnet; needs the keypairs from OQ-5, see [docs/environment.md](docs/environment.md#devnet-deploy)):

```sh
make deploy-devnet                                            # program, test-USDC mint, config
make deploy-devnet DEPLOY_ARGS="--feeds deployments/feeds.devnet.json"   # pin real Switchboard feeds
```

## Features

### Implemented (M1-M3)

**Solana Program**
- Binary 0DTE outcome markets on MAG7 stocks (AAPL, AMZN, GOOGL, META, MSFT, NVDA, TSLA)
- On-chain order book with limit orders (Buy YES, Sell YES, Buy NO, Sell NO)
- Four trade intents: bullish, bearish, inside strike, outside strike
- Switchboard Oracle integration for fair settlement
- Admin controls: add strikes, pause/unpause, force-settle with 60s delay
- Winner redemption ($1.00 per winning token, $0.00 for losers)

**Automation Services**
- Morning job: daily market creation at 9:30 AM ET
- Settlement job: closes markets at 4:00 PM ET, settles from oracle
- Fair-value pricing service (Python)
- Safety oversight with Claude API (ops-agent)

**Frontend (Next.js 15)**
- Markets page: live prices, order book, market status
- Trade page: four intent flows, wallet integration (Phantom/Solflare)
- Portfolio page: positions, P&L tracking, winner redemption
- History page: trade and fill history
- Admin page: add strikes, pause/unpause markets
- Status page: system invariants and liveness checks
- Test-USDC faucet (1 claim per wallet per 24h)

**Devnet Deployment**
- Live program on Solana devnet
- Switchboard feeds pinned and verified
- Automated lifecycle: create → trade → settle → redeem
- Fresh-clone reproducibility verified

### In Progress (M4)
- Red-team security validation (22 abuse cases)
- README and demo materials
- Final submission preparation

See [CHANGELOG.md](CHANGELOG.md) for complete feature list by milestone.

## Risks and limitations
See docs/risks.md (written in M4). No regulatory or compliance claims are made.
