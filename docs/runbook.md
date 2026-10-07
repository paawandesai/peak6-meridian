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
