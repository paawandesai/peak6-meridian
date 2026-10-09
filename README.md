<!-- OWNER: operator. -->
# Meridian

Binary 0DTE outcome markets on the MAG7 stocks, on Solana devnet. Each contract asks "Will TICKER close at or above STRIKE today?" and pays $1.00 test-USDC to YES or NO. Markets are created every trading morning, trade on an on-chain order book, settle from an oracle after the 4:00 PM ET close, and winners redeem.

**Live on Solana devnet.** No real funds; test-USDC only.

## Architecture

Meridian combines an Anchor program with automation services and a Next.js frontend:
- **On-chain program** (`programs/meridian`): Order book, minting, settlement, redemption
- **Automation** (`services/automation`): Morning market creation, settlement orchestration
- **Quant service** (`services/quant`): Fair-value pricing, market-making
- **Ops agent** (`services/ops-agent`): Settlement oversight with Claude API
- **Frontend** (`app/`): Markets, trading, portfolio, history, admin

For details: [docs/architecture.md](docs/architecture.md) · [docs/domain.md](docs/domain.md) · [docs/brief.md](docs/brief.md)

## Prerequisites

**System requirements:** Linux (Ubuntu 24.04 recommended), ~10 GB disk, 8 GB RAM.

**Install toolchain once:**
```bash
make toolchain  # Installs: Rust stable, Agave CLI 2.1.x, Anchor 0.31.1, Node 22, pnpm, uv
```

This installs all required build tools. See `Makefile` for exact versions.

## Quickstart (local)

From the repo root:
```bash
cp .env.example .env
make install          # Install dependencies
make build-local      # Build program with test oracle
make dev              # Start validator + app on http://localhost:3000
```

The local environment includes:
- Solana test validator on `localhost:8899`
- Next.js app on `http://localhost:3000`
- Seeded test markets for MAG7 tickers

To test the full lifecycle:
```bash
make e2e  # Create → mint → trade (4 paths) → settle → redeem
```

## Devnet

**Live deployment:**
- **App:** https://meridian-app.vercel.app _(when deployed)_
- **Program ID:** `3RovidBTwYzUfhniunxsUgnLzsbWz6qt3PGpvD23HDZq`  
  [View on Explorer](https://explorer.solana.com/address/3RovidBTwYzUfhniunxsUgnLzsbWz6qt3PGpvD23HDZq?cluster=devnet)
- **Test-USDC:** Get from the faucet button in the app (1 claim per wallet per 24h)

**Deploy to devnet** (requires keypairs per [docs/environment.md](docs/environment.md)):
```bash
make deploy-devnet  # Deploys program, creates test-USDC mint, initializes config
```

## Demo: Trading a Binary Contract

> **Note:** AC3 screenshots require running `make dev` to capture UI. Text walkthrough provided below. (AC3 unmet - screenshots pending environment setup)

Here's how to trade "Will AAPL close ≥ $230.00 today?" on devnet:

### 1. Get Test-USDC
1. Visit https://meridian-app.vercel.app
2. Connect your Phantom or Solflare wallet
3. Click "Get test-USDC" (header)
4. Approve the transaction

### 2. Navigate to Markets
- Click "Markets" in the navigation
- See today's strikes for AAPL, GOOGL, etc.
- Fair values, edge (rich/cheap), and implied distribution are shown

### 3. Buy YES
**Example:** "Will AAPL close ≥ $230.00?"

1. Click the $230 strike for AAPL
2. On the Trade page, select **Buy YES**
3. Enter quantity (e.g., 10 contracts)
4. Review: "You pay $X.XX. You win $10.00 if AAPL closes ≥ $230.00"
5. Click "Place Order"
6. Sign transaction in wallet

Your position appears in the Portfolio page.

### 4. Trade Other Paths
- **Sell YES:** Sell contracts you own
- **Buy NO:** Bet the stock closes below strike (mints a pair, sells YES)
- **Sell NO:** Exit a NO position (buys YES, redeems pair)

### 5. Settlement & Redemption
- Markets settle at 4:05 PM ET using Switchboard oracles
- After settlement, visit Portfolio
- Click "Redeem" on winning positions
- Winners receive $1.00 per contract; losers get $0

## Testing

**Unit and integration tests:**
```bash
make test          # Rust, TypeScript, Python tests
make test-security # Abuse-case tests (tests/security/)
make coverage      # Coverage gate (80%+ for services)
```

**End-to-end:**
```bash
make e2e  # Full lifecycle on local validator
```

**Linting and typecheck:**
```bash
make lint
make typecheck
```

**CI:** GitLab CI runs all checks on every push. Pipeline must be green to merge.

## Project Structure

```
.
├── programs/meridian/     # Anchor program (Rust)
├── crates/meridian-book/  # Order book matching engine
├── packages/client/       # TypeScript client SDK
├── app/                   # Next.js frontend
├── services/
│   ├── automation/        # Market creation & settlement (TypeScript)
│   ├── quant/             # Fair values & market maker (Python)
│   └── ops-agent/         # Settlement oversight (Python + Claude)
├── oracle/feeds/          # Switchboard feed definitions
├── scripts/               # Deployment & lifecycle scripts
├── tests/
│   ├── e2e/               # End-to-end tests
│   └── security/          # Abuse-case tests (AB-*)
└── docs/                  # Architecture, domain, requirements
```

## Documentation

- **[docs/brief.md](docs/brief.md)** - Project goals, scope, constraints
- **[docs/architecture.md](docs/architecture.md)** - System design, components, data flows
- **[docs/domain.md](docs/domain.md)** - Business rules, units, market lifecycle
- **[docs/requirements.md](docs/requirements.md)** - Functional and non-functional requirements
- **[docs/threat-model.md](docs/threat-model.md)** - Security analysis, attack surfaces
- **[docs/decisions.md](docs/decisions.md)** - Key technical decisions and rationale
- **[docs/status.md](docs/status.md)** - Implementation status, open questions
- **[CLAUDE.md](CLAUDE.md)** - Conventions for LLM coding agents

## Commands Reference

| Command | Purpose |
|---------|---------|
| `make toolchain` | Install Rust, Anchor, Node, pnpm, uv (once per machine) |
| `make install` | Install all project dependencies |
| `make build-local` | Build program with test oracle feature |
| `make build-devnet` | Build program for devnet (no test oracle) |
| `make client` | Regenerate TypeScript client from IDL |
| `make dev` | Run local validator + app |
| `make test` | Run all tests |
| `make test-security` | Run abuse-case tests |
| `make coverage` | Check coverage thresholds |
| `make e2e` | End-to-end lifecycle test |
| `make lint` | Lint Rust, TypeScript, Python |
| `make typecheck` | TypeScript type checking |
| `make deploy-devnet` | Deploy to Solana devnet |

See `make help` or `Makefile` for all targets.

## Risks and Limitations

**This is a devnet demo.** No real money. No regulatory compliance. No mainnet deployment.

Known limitations:
- Devnet only (test-USDC, no real funds)
- Single admin keypair controls markets and settlement
- Oracle outages halt settlement
- No mainnet deployment planned

See [docs/threat-model.md](docs/threat-model.md) for complete security analysis and [docs/brief.md](docs/brief.md) for project constraints.

## License

[TBD - Operator to add]

## Contributing

This is a demonstration project. Not accepting external contributions.

## Support

For questions about the architecture or codebase, see documentation in `docs/`.
