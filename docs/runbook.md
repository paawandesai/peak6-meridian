<!-- OWNER: operator. -->

# Peak6 Meridian — runbook

Operator-owned ops notes. Update when setup or recovery steps change.

## Repo and paths

- GitLab: https://labs.gauntletai.com/paawandesai/peak6-meridian (project id **2084**)
- Local clone: `/workspace/projects/peak6-meridian` (do **not** move)
- Remote: `https://labs.gauntletai.com/paawandesai/peak6-meridian.git`
- Default branch: `main` (protected: **no direct pushes**; Maintainers merge via MR; no force-push)

## AO project

- AO app: Agent Orchestrator v0.13.3 at `/workspace/ao-install/squashfs-root/agent-orchestrator`
- Data dir: `/home/box/.ao/data` · daemon port `3001` · `ao doctor` for health
- Registered project id: **`peak6-meridian`**
  - path: `/workspace/projects/peak6-meridian`
  - session prefix: `meridian`
  - orchestrator agent: **Claude Code** (`claude-code`)
  - worker agent: **Claude Code** (`claude-code`)
  - reviewer: **Cursor** (`cursor`)
  - env forwarded into sessions: `TIINGO_API_KEY`, `TWELVEDATA_API_KEY`, `FINNHUB_API_KEY` (never commit; local `.env` gitignored)
- Scope: work **M1** issues only until M1 closes (ticket file `docs/tickets/M1.md`; GitLab label `M1`)

### Useful AO commands

```bash
AO=/workspace/ao-install/squashfs-root/resources/daemon/ao
$AO status
$AO doctor
$AO project ls
$AO project get peak6-meridian --json
$AO session ls
$AO orchestrator ls
```

Restart AO desktop/daemon if needed: `$AO stop` then `$AO start` (or relaunch the AppImage under `/workspace/ao-install/`).

## Auth — Claude Code (workers / orchestrator)

- Binary: `/home/box/.local/bin/claude`
- Check: `claude auth status` (expect `loggedIn: true`, provider `claude.ai`)
- Quick smoke: `claude -p "reply with exactly: ok" --print </dev/null`
- Re-auth (no human password if device/browser flow works): `claude auth login` and complete the browser/device flow on this computer
- If AO model discovery fails with "no credential could be resolved", re-login then `$AO doctor` / restart daemon so harnesses refresh

## Auth — Cursor CLI (reviewer)

- Binary: `/home/box/.local/bin/cursor-agent`
- Check: `cursor-agent status` (expect logged in email)
- Re-auth: `cursor-agent login` (or the Cursor CLI login flow used on the other Grok Bot session); credentials live under `/home/box/.config/cursor/` and `/home/box/.cursor/`
- Confirm AO sees it: `$AO agent ls` → `cursor` row **installed / authorized**

## Auth — Gauntlet GitLab

- Tokens for AO/git live in `/home/box/.config/ao/gitlab.env` (`GITLAB_TOKEN`, `AO_GITLAB_*`, host `labs.gauntletai.com`)
- `ao doctor` may still FAIL `gitlab-token` against gitlab.com; Gauntlet host is what we use — verify with API `GET /api/v4/projects/2084`
- Push/MR auth: HTTPS with oauth2 + token via `GIT_ASKPASS` (never put the token in remote URLs that get logged)
- CI/CD deploy secrets (`VERCEL_*`, `RAILWAY_TOKEN`) are **GitLab CI variables** (masked/protected), not local `.env` — see `docs/environment.md`

## Restarting stalled work

1. Re-read `docs/operating-rules.md` and `docs/status.md`.
2. `$AO session ls` / `$AO orchestrator ls` — note stuck sessions (no progress, repeated failures).
3. Soft recovery: send a clarifying prompt with `$AO send` if available; otherwise stop the stuck session and spawn a fresh worker on the same issue with attempt count noted in `status.md`.
4. After **3** failed attempts on a ticket: re-scope (Tier 1) or escalate if milestone scope would change.
5. If Claude Code or Cursor hits usage/rate limits: pause dispatch, note reset time in `status.md`, resume after; escalate only if stalled **> 6 hours**.
6. Kill switch: on **PAUSE**, stop dispatching; let in-flight finish or stop safely; confirm; resume only on **RESUME**.

## GitLab operator checklist

- Labels: `M1`, `human-approved` (never apply `human-approved` except HUMAN DOC UPDATE)
- **M1-01 merged** (2026-10-06). "Pipelines must succeed" is on; daily heartbeat schedule **id 20** (`HEARTBEAT=1`, `0 14 * * *` America/Chicago). Feature MRs still need green CI + Cursor approve (D-045 = docs-only tie-break only).
- Merge only when: GitLab pipeline green + Cursor review vs `docs/review.md` (or logged tie-break) + ACs met

## Heartbeats / monitors

- Operator heartbeat: every 30–60 minutes while unblocked work remains
- Grok Bot routine **Meridian worker stage monitor**: every 5 minutes weekdays **8:02 AM–8:57 PM** America/Chicago

## Rehearsal

The Thursday devnet rehearsal (M2-12; the day's markets settle at 16:05 ET). Script: `tests/e2e/src/lifecycle.ts --cluster devnet`, run as `pnpm --filter e2e run rehearsal --phase <markets|trade|redeem>`. It never creates a Config, mint or deploy; those are M2-01 (`make deploy-devnet`). All times ET (`America/New_York`).

**Who:** the operator, or an AO worker the operator names. Whoever runs a step writes one line per step in `docs/log.md`: who, UTC and ET time, step, outcome, explorer links. No secrets, keypair contents or RPC URLs with API keys in the log or the MR.

**Environment** (`.env`, gitignored; see `docs/environment.md`): `SOLANA_CLUSTER=devnet`, `SOLANA_RPC_URL`, `ADMIN_KEYPAIR_PATH` (pays fees, funds SOL), `MERIDIAN_PROGRAM_ID` (if not the default). `FAUCET_URL` for `--fund faucet` (the default); `FAUCET_KEYPAIR` only for `--fund direct`; `ANCHOR_WALLET` (automation keypair file) only for `--phase markets`. The script verifies the cluster by genesis hash before reading any key; it refuses a non-devnet RPC and exits with nothing sent.

### Timeline

| ET | Step | Who / how |
|---|---|---|
| before 08:00 | Check devnet: `make deploy-devnet` re-run sends no tx (program, mint, Config current), automation service up (Railway, M2-11) or started per the fallback below | operator |
| 08:00 | Morning job creates the day's markets | automation |
| by 08:00 | If no markets exist yet, use **Fallback B** (must be done before 09:00) | operator / AO worker |
| 09:30–15:00 | `--phase trade`: funds trader-a/b, runs Buy YES, Sell YES, Buy NO, Sell NO on the lowest open META strike, checks vault/escrow invariants after each step, saves `target/rehearsal/state.json` and the trader keypairs (gitignored, mode 0600) | operator |
| 16:00 | Markets close | |
| 16:05 | Settlement by the automation service (Switchboard) | automation |
| ≤16:15 | Check every market settled within 10 min of close (**AC2**). If not, diagnose (automation logs, `docs/runbook.md`, alerts) and open a fix ticket before Friday | operator |
| after settlement | `--phase redeem`: settle_funds, redeem, exact P&L check against the independent model | operator |

`--phase trade` flags: `--symbol META` (default), `--strike-cents N`, `--state-dir DIR`, `--fund faucet|direct|none`. It needs an open market with at least 180 s before close, and an empty book. It refuses to trade twice into the same state dir.

### Funding the traders

- **Faucet (default, `--fund faucet`):** needs `FAUCET_URL` (the running app, e.g. `http://localhost:3000` from `make dev` with the devnet env, or the Railway/Vercel URL) and the app's `USDC_MINT` equal to the Config's mint. The admin sends 0.1 SOL to each trader and the script claims test-USDC for each wallet through `POST /api/faucet` (M2-09). The faucet allows one claim per wallet per 24 h and mints `FAUCET_AMOUNT_USDC` (default 1,000); a 429 is accepted if the wallet already holds 1,000. If a wallet is short, the script says so and stops: top it up by hand or use `--fund direct`.
- **App not running (`--fund direct`):** mints 1,000 test-USDC to each trader with the `FAUCET_KEYPAIR` mint authority and sends 0.1 SOL from the admin.
- **By hand (`--fund none`):** the script prints both trader wallet addresses and creates their USDC token accounts, then fails until each wallet has at least 0.03 SOL and 1,000 test-USDC. Fund them (the app faucet with the wallet imported from `target/rehearsal/trader-a.json` / `trader-b.json`, or a transfer), then re-run the same command.

### Fallback A: AO worker runs the automation service (Railway tokens or M2-11 late)

An AO worker session runs `pnpm --filter automation start` against devnet with `TZ=America/New_York` and the devnet env (`AUTOMATION_KEYPAIR`, `SOLANA_RPC_URL`, `SOLANA_CLUSTER=devnet`, API keys from the forwarded env) from before 08:00 until at least 16:15 ET, and the operator records in `docs/log.md` which session ran it (session ID, start and stop times). The app and faucet run locally against devnet (`make dev` with the devnet env) until M2-11 lands. Check the process is alive at 15:55 ET, because settlement at 16:05 depends on it.

### Fallback B: markets not created by 08:00 ET

The operator or an AO worker creates the day's markets before 09:00 ET with the create-markets CLI path:

1. Write the previous closes for the trading date, from both Tiingo and Twelve Data (they must agree within 5 bps), to a file such as `target/rehearsal/prev_closes.json`: `{"tradingDate":"YYYY-MM-DD","closes":{"AAPL":23000,...,"TSLA":25000}}` (integer cents, all seven tickers).
2. `ANCHOR_WALLET=<automation keypair file> pnpm --filter e2e run rehearsal --phase markets --prev-closes target/rehearsal/prev_closes.json`. Safe to re-run: markets that exist are skipped.
3. Log it in `docs/log.md`: who, time, number created, explorer links.

### Testing the script without devnet

Against a local validator: `SOLANA_CLUSTER=localnet` with a loopback `SOLANA_RPC_URL`, the markets seeded by `E2E_SEED_ONLY=1 ... pnpm --filter e2e run lifecycle` (use `E2E_CLOSE_IN_SECS` of about 420), then `--phase trade --fund direct` (the default `--fund faucet` needs `FAUCET_URL` and a running app; on a seeded local validator the admin is the mint authority, so set `FAUCET_KEYPAIR` to the admin keypair's JSON array), then `--phase redeem --local-settle` (the local oracle settles; the flag is refused on devnet). Unit tests: `pnpm --filter e2e run test`.

## Faucet (M2-09)

- The server faucet (`POST /api/faucet`) mints test-USDC with `FAUCET_KEYPAIR`, which is the mint authority, and pays rent from its own SOL: about 0.004 SOL per claim (two 1-byte marker accounts plus the recipient's token account). Keep that key funded on devnet (`solana airdrop`, or a transfer from the admin key).
- Below `FAUCET_MIN_LAMPORTS` (default 0.1 SOL) the endpoint answers 503 and posts one alert to `ALERT_WEBHOOK_URL` per instance per `FAUCET_ALERT_COOLDOWN_SEC`. Top up the key; no restart is needed.
- A claim limit of one per wallet per 24 h is enforced on chain by marker accounts; there is nothing to reset. A refused wallet (429) simply waits: the gap is at least 24 h minus about 90 s, and up to about 48 h.
- A "faucet misconfigured" error means `FAUCET_KEYPAIR` is not the mint authority of `USDC_MINT`; fix the environment and redeploy.
