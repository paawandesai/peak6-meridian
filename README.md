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
- **Program ID (re-keyed in D-053, deployed):** [`H8SBU6m8sGRvKudUGhroDP4oEMyvF9QDhVc9wTFESXSm`](https://explorer.solana.com/address/H8SBU6m8sGRvKudUGhroDP4oEMyvF9QDhVc9wTFESXSm?cluster=devnet) (its keypair is held outside the repo; see [docs/decisions.md](docs/decisions.md)). Upgrade authority and admin: `6cp7ExvkgtdQuMyJXv26wg8Z2MBJT2idPdTkXx13F5Se`. The deployment record is `deployments/devnet.json`; the Config feeds are still placeholders until M2-02's live feeds are pinned.
- **Test-USDC mint:** [`GKuoE1akZCNnA4ouVdB6P3ngSnanBM28oydPS54fSnT5`](https://explorer.solana.com/address/GKuoE1akZCNnA4ouVdB6P3ngSnanBM28oydPS54fSnT5?cluster=devnet) (6 decimals, mint authority = the faucet key `32eaD4Hp5WQ4UeD8S7eFVCVtxBvZuBpQzE4Byt7JLju7`). Config PDA: [`6Bf88kHFDDjdXG1BEdrj1edkLwWt9pEiKPFp6Ekhkoew`](https://explorer.solana.com/address/6Bf88kHFDDjdXG1BEdrj1edkLwWt9pEiKPFp6Ekhkoew?cluster=devnet) (automation authority `7JFyYPJyhJokQ3wMKHwJwb35MFj87snz52nTUS6qeEMy`).
- **Frontend URL, how to get test-USDC:** _filled in when the app is deployed (M2)._

Deploy (idempotent, refuses any cluster whose genesis hash is not devnet; needs the keypairs from D-053 (OQ-5), see [docs/environment.md](docs/environment.md#devnet-deploy)):

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
