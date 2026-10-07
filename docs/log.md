<!-- OWNER: operator. -->
# Log

Append-only. Newest entry at the bottom. Format: `## YYYY-MM-DD HH:MM ET · <who>` then a few lines. Never edit or delete past entries. The CI `heartbeat` job fails if this file hasn't changed in 24 hours.

## 2026-10-06 14:30 ET · kickoff
Kickoff pack created.

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
