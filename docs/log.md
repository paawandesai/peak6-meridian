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
