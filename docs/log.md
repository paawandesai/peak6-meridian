<!-- OWNER: operator. -->
# Log

Append-only. Newest entry at the bottom. Format: `## YYYY-MM-DD HH:MM ET · <who>` then a few lines. Never edit or delete past entries. The CI `heartbeat` job fails if this file hasn't changed in 24 hours.

## 2026-10-06 14:30 ET · kickoff
Kickoff pack created.

## 2026-10-06 — CI runner maintenance / tagging (operator)

- ~15:30 CT: shared CI runner maintenance window. Pipelines that **failed or were canceled** in that window are **retried** and **do not count** toward any ticket's 3-attempt limit.
- Runner setup (current): **untagged** jobs run on the dedicated Meridian project runner; jobs tagged `heavy` (E2E, red-team, browser tests) run on the shared runner, one at a time.
- If any job sits **pending > 10 minutes**, escalate to the human with job name + project — do not keep retrying (likely missing/mis-tagged runner).
- Applied: retried canceled MR !2 pipelines from the window; current focus remains pipeline on draft MR !2 (M1-01).

## 2026-10-06 16:01 CT · operator
Maintenance-window pipeline pass (project 2084):

- **Retried / already covered:** MR !2 pipeline **39093** jobs `test`/`coverage` failed `runner_interrupted` at ~20:56Z (runner #291 restart); retries **157075/157076** already running on #291 — **do not count** toward M1-01's 3 attempts.
- **Not retried (out of window / superseded):** pipes **39091** and **39083** were auto-canceled before the ~15:30 CT window when newer MR commits landed; brief mistaken retries were **re-canceled** so they do not steal the dedicated runner from 39093. Pipe **39024** (`ci-probe`) failed earlier (~14:34 CT) — left as-is.
- **Runner rules reminder:** untagged → project runner #291 (meridian); `heavy` (E2E/red-team/browser) → shared runner one-at-a-time. Escalate if any job **pending >10 min** (do not retry forever).
- **Status now:** 39093 check stage green; test+coverage running on #291; e2e still `created` (stage-gated, not runner-pending). No pending>10m jobs to escalate.
- Log MR: !3 (`ops/log-runner-maintenance`).

## 2026-10-06 19:20 ET · operator (via M1-01 worker)
- M1-01 "Scaffold the monorepo and GitLab CI" merged: MR !2, merge commit `52dcb6d`. Pipelines 39177 (168019e) and 39300 (6c32d0b) green on all 8 jobs.
- Human decision: runner #235 `maximum_timeout` raised 600 s → 3 600 s. Runner rules: untagged jobs → dedicated Meridian runner #291; jobs tagged `heavy` (e2e, red-team, browser) → shared runner #235, one at a time; any job pending > 10 min is escalated to the human, not retried.
- Cursor review: 2 passes on MR !2; one minor finding (toolchain.sh dropped the platform-tools cache symlink), fixed in 6c32d0b, then approved.
- Open questions added: OQ-7 (cargo-audit upstream warnings), OQ-8 (CI runner capacity vs NFR-18).

## 2026-10-06 19:15 CT · operator
Post-M1-01 kickoff step 10 gates applied (operating-rules):

- Enabled GitLab setting `only_allow_merge_if_pipeline_succeeds` (Pipelines must succeed).
- Created daily pipeline schedule id **20** on `main`: cron `0 14 * * *` America/Chicago, variable `HEARTBEAT=1` (log-freshness heartbeat job).
- Main post-merge pipeline [39399](https://labs.gauntletai.com/paawandesai/peak6-meridian/-/pipelines/39399) on `52dcb6d4` tracked (await/confirm green before merging doc MRs !1 / !3).
- Operator decisions for M1-01 logged as D-035–D-044 in `docs/decisions.md`.

## 2026-10-06 20:50 CT · operator
- M1-03 matching engine merged: MR !5, merge commit `b91e208`. Pipeline green; Cursor approved. `crates/meridian-book` + AB-09/AB-10 on main.
- M1-08 strike calculator / NYSE calendar / prevCloses merged: MR !7, merge commit `eb5fe77`. Pipeline green; Cursor approved.
- Main pipeline #39660 success on `eb5fe77`.

## 2026-10-06 21:55 CT · operator
PRD/docs verification (local `.ao-ops/prd-docs-verification.md`):
- Open MRs: !8 M1-02 (CI running post BookOrder fix; needs Cursor re-approve), !9 M1-09 draft (audit:deps fail on `bigint-buffer`), !10 M1-11 (CI running).
- `status.md` refreshed for M1-03/M1-08 coverage; no human-owned files touched.
- !8 not merged this loop (CI not green + no Cursor approve; D-045 docs-only only).

## 2026-10-07 10:18 CT · operator
- M1-02 merged earlier today: MR !8 → `ecf72eb` (squash `a3840c1`); Cursor APPROVE on tip after reviewer tmux fix.
- M1-11 already on main: MR !10 → `a1c486a`.
- **OQ-10 accepted** by Paawan (~10:17 CT): six LiteSVM-only `.cargo/audit.toml` ignores → **D-047**. NFR-10/AB-16 unchanged; remove ignores at Agave ≥ 2.2.
- Docs MR: `ops/oq-10-accept` (decisions + status + audit.toml header).

## 2026-10-07 20:40 CT · operator
- **D-048** (By: human): UI clarity/usability track approved by Paawan. Orchestrator designs with `/design` (UI-01 → `docs/design.md`, no code); Sonnet workers implement UI-02+; Cursor reviews against ticket + design.md. Never blocks M2/M3 exits or the 16:05 ET settlements; code freeze Sun 2026-10-11 09:00 CT.

## 2026-10-07 21:07 CT · orchestrator
- UI-01 design spec drafted by the orchestrator with the frontend-design plugin (/design command not available in session); docs/design.md + UI-02..UI-08 tickets added to docs/tickets/M1.md (D-048). Docs only.

## 2026-10-07 23:25 CT · orchestrator
- **M2 tickets** M2-01..M2-13 drafted by the orchestrator (Tier 2, Paawan notified; By: orchestrator); UI-04/05/06/08 design ACs folded into M2-06/07/08/10. MR !24.

## 2026-10-08 17:55 CT · orchestrator
- M3 tickets M3-01..M3-09 drafted by the orchestrator (Tier 2, Paawan notified).

## 2026-10-09 09:50 EDT · AO worker peak6-meridian-39
M2-12 live devnet rehearsal: pre-flight
- Deployment verified: make deploy-devnet (dry-run, no tx sent - program and config current)
- Automation service: Fallback B used (no automation running)
- Markets created: Fallback B manual creation - 14 new markets created, 32 already existed
- Previous closes fetched from Tiingo API for all MAG7 tickers (2026-10-09)
- Market creation explorer links:
  - Sample META markets: LyTdfVXH9kDyuF9w38djSkWtbpi2FQXxv5rQSty9qEcq3wVhpxbj4JSg6kbigrBnQ7JTrnBTcyMxtq9piDLqLVT
  - Sample TSLA markets: 5XyQiNMndS7xE6Dpg33JumxiG4AJj98hyPT9ydtpyi1sM9Z3PE1JhuCDMSomMuBxgNwRQj8E3uP3PK58XcsoRdnX
- Next: trade phase

## 2026-10-09 09:52 EDT · AO worker peak6-meridian-39
M2-12 live devnet rehearsal: trade phase
- Command: pnpm --filter e2e run rehearsal --phase trade --fund direct
- Symbol: META, strike: $660.00 (66000 cents)
- Market: 62gu1va8jFJKR2KDwssgs2inMeX1iuwzbj6Hqh1cwUJf
- Close time: 2026-10-09T20:00:00.000Z (16:00 EDT / 4:00 PM EDT)
- Outcome: SUCCESS - all 4 trade paths executed
- Trader wallets: Hprwcmcd9eTkTg6aa9tv93SpPNALUL3NhkpsKnZS9uFM (trader-a), 436sjKf5xMacTDnQWdqpPZFmryGqGvSkf3YDczfHZFCg (trader-b)
- Explorer links (devnet):
  - Fund trader-a SOL+USDC: https://explorer.solana.com/tx/3PUKDQrjVNQHjCSMEJL3SUynyv4FJiRV6dGzx1Qh1nAeN4NwZ8z3tDx3QJsCusMVLM52sRHdr9dZXjM3tNCXZMCs?cluster=devnet
  - Fund trader-b SOL+USDC: https://explorer.solana.com/tx/3x7731UVLj47qo5oKTTzViopXuMu4jysjvoS5aKxrx58oDC4pioXQC9G3Rs1EvqV8gLhP9DfBVNSuFdL1LY5wr2X?cluster=devnet
  - Mint 20 pairs (trader-b): https://explorer.solana.com/tx/3gxWaVfuQ1dn16zAv1tAUWqziCqhAivgBMvFnMArWeCwPW5Vq7rT9HD7CNaR7bXxtQcACUYVs2B7oRqUrmczBiu2?cluster=devnet
  - Sell YES order (trader-b 10@60¢): https://explorer.solana.com/tx/5pLnBFAesjeT1g1xoAKGDhddR2EGZ5vNPsaPCS1m1rUdoBXesWCaEGEQ78mYDGBrAB7EYjsTvy9xhn5pGbQ1dbYs?cluster=devnet
  - Buy YES (trader-a IOC 10@60¢): https://explorer.solana.com/tx/EjYhDwx8X9DMQPYb86KNB7CgHSufdUugaMox1CbcZ5E8W4uC5eyQ3KsgSAqQauwcUpn5MnqmjfC2pH7i4aebCEG?cluster=devnet
  - Sell YES bid (trader-b 4@55¢): https://explorer.solana.com/tx/XTbaajUSRpPQdsqHeZxqkUP6xb8goRDEacq73eRp9z4rCD1bJTynkDfyS12Dt3sjo3mfEZq22YG8towPpuNaoyc?cluster=devnet
  - Sell YES (trader-a IOC 4@55¢): https://explorer.solana.com/tx/NK4CvuqCfS6e3hpUSteqmHJKo2Ecoq1VNV1XCnzQDVxKBkuaQ2y34zAvuQ4QSvphJxvypDhZM2KSshixCoQsNyZ?cluster=devnet
  - Buy NO bid (trader-b 3@45¢): https://explorer.solana.com/tx/4AHjJoXB34DmUeXahiPZKmz8MBNDKtZDNVQ9EnrEnje3dWh8JsWKdcr8Vsmf8stNMvEmxT8BYBfzCV2RGKrErps8?cluster=devnet
  - Buy NO (trader-a IOC 3@55¢ YES = 45¢ NO): https://explorer.solana.com/tx/4WD6qQ9VGjyLonKZZjpXfoXonUktXod76kX4A3acrfpxnuDnnzS73iPZivVcEb6Vwg1FgLjFnkdXVwMuy26RuGqK?cluster=devnet
  - Sell NO ask (trader-b 1@70¢): https://explorer.solana.com/tx/226TYgh45gxQtC3JFzxwZK1Y57hiEdGWXYLyprTyD7cjDTWwnUBS5yX3Hnqgnmp3taYHkYgKD2yHWAUZj94U58NY?cluster=devnet
  - Sell NO (trader-a IOC 1@70¢): https://explorer.solana.com/tx/44Kwd69Rc9gGhhpkL8K9TtDZtdDMPqJfW9AMqX27toF2zWux4GHcp7fGJvFpzTvZPdEgTbPEYysCu9Uhff5dHQ5Y?cluster=devnet
- State saved: target/rehearsal/state.json
- Next: await settlement at 16:05 ET (20:05 UTC), then run redeem phase

## YYYY-MM-DD HH:MM ET · <who>
M2-12 live devnet rehearsal: settlement verification (AC2)
- Markets closed: 16:00 ET
- Settlement time: <HH:MM ET>
- Within 10 min of close: <YES|NO>
- All markets settled from RedStone oracle: <YES|NO: details>
- If delayed/failed: <diagnosis, fix ticket opened>
- Next: redeem phase

## YYYY-MM-DD HH:MM ET · <who>
M2-12 live devnet rehearsal: redeem phase
- Command: pnpm --filter e2e run rehearsal --phase redeem
- Outcome: <SUCCESS: P&L exact match|FAILED: reason>
- Explorer links (devnet):
  - Settle funds trader-a: https://explorer.solana.com/tx/<sig>?cluster=devnet
  - Settle funds trader-b: https://explorer.solana.com/tx/<sig>?cluster=devnet
  - Redeem trader-a: https://explorer.solana.com/tx/<sig>?cluster=devnet
  - Redeem trader-b: https://explorer.solana.com/tx/<sig>?cluster=devnet
- P&L verification: <details of exact match against ledger.ts model>
- M2-12 AC1 complete: <YES|NO>

## 2026-10-09 13:40 ET · worker
M2-12 settlement and redeem phases deferred: awaiting #46 (RedStone settle_market) and #47 (settle_funds + redeem). Trade phase evidence above satisfies partial AC1 (four intents with explorer links). AC2 (settlement within 10 min) will be filled when #46/#47 land and the full end-to-end run completes.
