# M2-12 Live Devnet Rehearsal Checklist

**Blocked on:** MR !45 (M2-01 live re-key) must be merged first for devnet program ID and keypairs.

This checklist guides the live devnet rehearsal run per issue #28 and `docs/runbook.md#rehearsal`. Run on a Thursday; markets settle at 16:05 ET.

## Pre-requisites (verify before starting)

- [ ] MR !45 merged (provides devnet program ID and keypairs)
- [ ] M2-02/M2-03/M2-04 deployed (Switchboard feeds, automation service)
- [ ] Devnet keypairs available:
  - `ADMIN_KEYPAIR_PATH`: admin key (pays fees, funds SOL)
  - `AUTOMATION_KEYPAIR` or `ANCHOR_WALLET`: automation key (for Fallback B if needed)
  - `FAUCET_KEYPAIR`: faucet key (for `--fund direct` if needed)
- [ ] Environment variables configured in `.env`:
  - `SOLANA_CLUSTER=devnet`
  - `SOLANA_RPC_URL` (devnet RPC)
  - `MERIDIAN_PROGRAM_ID` (from !45 deploy)
  - `USDC_MINT` (from !45 deploy)
  - `FAUCET_URL` (Railway/Vercel app URL, for `--fund faucet` default)
  - API keys: `TIINGO_API_KEY`, `TWELVEDATA_API_KEY`, `FINNHUB_API_KEY`
- [ ] Admin key has devnet SOL (for trader funding)
- [ ] Faucet key has devnet SOL (≥0.1 SOL, per runbook)

## Timeline (all times ET / America/New_York)

### Before 08:00 ET — Pre-flight check
- [ ] Verify devnet deployment current: `make deploy-devnet` (dry-run, sends no tx)
- [ ] Check automation service running (Railway) or prepare Fallback A
- [ ] If using Fallback A: start `pnpm --filter automation start` in an AO worker session with `TZ=America/New_York` and devnet env
- [ ] Record pre-flight checks in `docs/log.md`

### 08:00 ET — Morning job creates markets
- [ ] Automation service creates today's markets (automated)
- [ ] **OR** use Fallback B if markets not created:
  1. Write previous closes to `target/rehearsal/prev_closes.json`:
     ```json
     {"tradingDate":"YYYY-MM-DD","closes":{"AAPL":23000,"MSFT":42000,"GOOGL":17500,"AMZN":21000,"NVDA":14000,"META":68000,"TSLA":25000}}
     ```
  2. Run: `ANCHOR_WALLET=<automation-keypair-path> pnpm --filter e2e run rehearsal --phase markets --prev-closes target/rehearsal/prev_closes.json`
  3. Record in `docs/log.md`: who, time, number created, explorer links

### 09:30–15:00 ET — Trade phase
Run: `pnpm --filter e2e run rehearsal --phase trade`

Default flags:
- `--symbol META` (default)
- `--fund faucet` (default; requires `FAUCET_URL`)
- State saved to `target/rehearsal/state.json` and trader keypairs (gitignored, mode 0600)

Alternative funding:
- `--fund direct`: uses `FAUCET_KEYPAIR` to mint, admin pays SOL
- `--fund none`: prints addresses, waits for manual funding

**After trade phase:**
- [ ] Record in `docs/log.md`:
  - Who ran it, UTC and ET time
  - Command and flags used
  - Outcome (success/failure)
  - Explorer links for all transactions
  - Trader wallet addresses (public keys only, never secret keys)

### 16:00 ET — Markets close

### 16:05 ET — Settlement
- [ ] Automation service settles markets (automated)
- [ ] If Fallback A: check automation process still alive at 15:55 ET

### ≤16:15 ET — Verify settlement (AC2)
- [ ] Check every market settled from Switchboard within 10 min of close
- [ ] If settlement failed or delayed:
  - Diagnose: check automation logs, runbook, alerts
  - Open a fix ticket before Friday
- [ ] Record settlement verification in `docs/log.md`

### After settlement — Redeem phase
Run: `pnpm --filter e2e run rehearsal --phase redeem`

Uses the state from `target/rehearsal/state.json` created during trade phase.

**After redeem phase:**
- [ ] Record in `docs/log.md`:
  - Who ran it, UTC and ET time
  - Outcome (exact P&L check passed/failed)
  - Explorer links for settle_funds and redeem transactions

## Evidence Requirements (issue #28 AC1)

All evidence goes in `docs/log.md` following the append-only format:

```markdown
## YYYY-MM-DD HH:MM ET · <who>
M2-12 live devnet rehearsal: <phase>
- Command: pnpm --filter e2e run rehearsal --phase <trade|redeem> [flags]
- Outcome: <success/failure with details>
- Trader wallets: <trader-a pubkey>, <trader-b pubkey>
- Explorer links:
  - Trade 1 (Buy YES): https://explorer.solana.com/tx/<sig>?cluster=devnet
  - Trade 2 (Sell YES): https://explorer.solana.com/tx/<sig>?cluster=devnet
  - Trade 3 (Buy NO): https://explorer.solana.com/tx/<sig>?cluster=devnet
  - Trade 4 (Sell NO): https://explorer.solana.com/tx/<sig>?cluster=devnet
  - Redeem: https://explorer.solana.com/tx/<sig>?cluster=devnet
```

**Never include:**
- Secret keys or keypair contents
- RPC URLs with API keys
- Internal token values

## Troubleshooting

**Markets not created by 08:00:**
- Use Fallback B (see above)
- Markets must be created before 09:00 ET

**Faucet 429 (rate limit):**
- Wait 24 hours since last claim, or
- Use `--fund direct` or `--fund none`

**Insufficient SOL:**
- Admin key: `solana airdrop 1 <admin-pubkey> --url devnet`
- Faucet key: transfer from admin or airdrop

**Settlement delayed/failed:**
- Check automation logs (Railway or local process)
- Verify Switchboard feeds updated
- Check RPC connectivity
- Open fix ticket before Friday if unresolved

**Script refuses to run:**
- Genesis hash check: ensures devnet only (refuses mainnet/testnet)
- Check `SOLANA_CLUSTER=devnet` in env
- Verify RPC URL is devnet
