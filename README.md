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
_Filled in when M2 ships: program ID, frontend URL, how to get test-USDC._

## Demo
_Filled in as milestones ship._
- **M1:** _pending_
- **M2:** _pending_
- **M3:** _pending_
- **M4:** _pending_

## Risks and limitations
See docs/risks.md (written in M4). No regulatory or compliance claims are made.
