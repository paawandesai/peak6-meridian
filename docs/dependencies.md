# Dependency Justifications

Major dependencies and their justifications per FR-31. Version pins and security details in [architecture.md](architecture.md) § Tech stack and [decisions.md](decisions.md).

## On-chain Program

### Anchor Framework (0.31.1)
- **Why:** PRD preference (D-001); industry-standard Solana framework with type-safe client generation, PDA derivation, and account validation macros
- **Alternatives rejected:** Native Solana program (verbose, error-prone account checks); Seahorse (Python-based, less mature)
- **Risk mitigation:** Version pinned to 0.31.1 (D-035) matching Switchboard SDK examples (D-005); program-specific clippy denials (D-039) enforce safety beyond Anchor defaults

### SPL Token (anchor-spl 0.31.1)
- **Why:** Standard for fungible tokens on Solana; YES/NO mints use classic SPL Token with market PDA as mint authority
- **Alternatives rejected:** Token-2022 (no needed features, D-003)
- **Risk mitigation:** Mint authority = market PDA ensures tokens can only be created via `mint_pair`

### Switchboard On-Demand (0.13.x)
- **Why:** Free on devnet, multi-source custom feeds with hash pinning, pull-based updates in the same transaction as settlement (D-005, D-007)
- **Alternatives rejected:** Pyth (requires paid plan for US equities, $5,000/month; D-005); Chainlink (devnet support unclear); own oracle (fallback D-005b not needed)
- **Risk mitigation:** Feed hashes pinned in Config; two independent sources (Tiingo, Twelve Data) with on-chain spread check (D-033); oracle adapter module keeps it swappable (D-005)

### LiteSVM (test/dev only)
- **Why:** Fast in-process program tests without a validator; property tests for invariants (D-017)
- **Alternatives rejected:** Only integration tests against `solana-test-validator` (slow, harder to property-test)
- **Risk mitigation:** Dev-only dependency; `.cargo/audit.toml` ignores limited to LiteSVM path (D-047, OQ-10); coverage enforced via real `.so` tests (D-031)

## Frontend (Next.js App)

### Next.js 15 + React 19
- **Why:** PRD preference (D-001); App Router provides server components for API proxying (faucet, market-data, ops-agent); React 19 concurrent features improve UX
- **Alternatives rejected:** Vite/React SPA (no server-side proxy for API keys); other frameworks (not PRD stack)
- **Risk mitigation:** Server actions and API routes keep `SERVICE_TOKEN`, data API keys, and `ANTHROPIC_API_KEY` server-only (never in bundle, tested in AB-17)

### Solana Wallet Adapter (@solana/wallet-adapter-react)
- **Why:** Standard library for Phantom, Solflare, and other Solana wallets (D-026)
- **Alternatives rejected:** Hand-rolling wallet connections (reinventing the wheel)
- **Risk mitigation:** Wallet only signs transactions user explicitly reviews; no programmatic signing

### Recharts
- **Why:** Declarative charting library for the implied distribution chart (M3-03); well-known, accessible, no exotic deps
- **Alternatives rejected:** D3 (lower-level, steeper curve); Chart.js (less React-idiomatic); Victory (larger bundle)
- **Risk mitigation:** Chart data is public (derived from on-chain books); no sensitive input

### Tailwind CSS
- **Why:** PRD preference (D-001); utility-first styling with no runtime, consistent design system
- **Alternatives rejected:** CSS-in-JS libraries (runtime cost); component libraries (D-048 UI pass uses no component library)
- **Risk mitigation:** Purely presentational; no security surface

## Backend Services

### Node.js 22 LTS (automation service)
- **Why:** PRD preference (D-001); `node-cron` with `TZ=America/New_York` for reliable 08:00 / 16:05 ET scheduling
- **Alternatives rejected:** Python (viable but mixing stacks unnecessarily); cron on the host (timing drift risk, D-015)
- **Risk mitigation:** Timeouts on all HTTP requests; alerting on failures; Switchboard retries with exponential backoff

### Python 3.12 (quant, ops-agent)
- **Why:** PEAK6's language where PRD is silent (D-018); `solders` for Solana keypair signing (quant), `anthropic` SDK for ops-agent LLM
- **Alternatives rejected:** TypeScript (viable but Python is PEAK6 stack); Java (D-018 "No Java")
- **Risk mitigation:** `mypy --strict` type checking; `pydantic` validation at every boundary; `uv` lock file for reproducible builds

### pnpm (JavaScript package manager)
- **Why:** Fast, space-efficient, strict (no phantom deps); workspaces for monorepo (D-032)
- **Alternatives rejected:** npm (slower, less strict); yarn (deprecated classic, or v2+ with PnP complexity)
- **Risk mitigation:** `pnpm-lock.yaml` committed; `pnpm audit --audit-level high` in CI (D-037 overrides for patched upstream)

### uv (Python package manager)
- **Why:** Fast, single-file lockfile (`uv.lock`), workspace support, deterministic installs (D-032, D-044)
- **Alternatives rejected:** pip + pip-tools (slower, more moving parts); poetry (heavier)
- **Risk mitigation:** `uv.lock` committed; `uv_build` backend for packages (D-044); `pip-audit` in CI

## Data & External Services

### Tiingo + Twelve Data (free tiers)
- **Why:** Official daily closes for US equities, free, two independent vendors for spread check (D-008, D-033)
- **Alternatives rejected:** Alpha Vantage (25 requests/day too limiting); paid feeds (over budget); single source (no redundancy)
- **Risk mitigation:** Keys in CI variables, passed to Switchboard via `variableOverrides` (D-053, OQ-11); settlement fails if sources disagree by > 5 bps

### Finnhub (free tier)
- **Why:** Third source for live spot prices (fair value engine) and cross-checks; free tier sufficient for 7 tickers × low traffic
- **Alternatives rejected:** None needed; Finnhub added as optional third source
- **Risk mitigation:** Server-side only; stale price (> 10 s) is flagged in `/fair-values` response (M3-01 AC4)

### Anthropic Claude API
- **Why:** Ops-agent investigation and override-draft narrative; best-in-class reasoning for settlement-failure diagnosis (D-025, D-021 differentiator C)
- **Alternatives rejected:** No LLM (deterministic fallback used when API fails or budget exhausted, M3-05 AC3); other LLM providers (Anthropic chosen for quality)
- **Risk mitigation:** Budget cap `OPS_AGENT_BUDGET_USD` (default $20 for the week); agent never signs or holds keys (D-025, AB-14/AB-15/AB-20); LLM output is validated before use (M3-05 AC2); deterministic fallback ensures override path works without API

## Hosting & Infrastructure

### Vercel (free tier, app)
- **Why:** Simple, zero-config Next.js deployment; free tier sufficient for devnet demo traffic (D-015)
- **Alternatives rejected:** Railway for both (app + services would exceed $5/month); self-hosted (setup time)
- **Risk mitigation:** Environment variables set via CLI (tokens in GitLab CI); no Git integration (D-051)

### Railway (~$5/month, automation + quant + ops-agent)
- **Why:** Simple service deployment with cron-like uptime; ~$5/month for all three services fits budget (D-015)
- **Alternatives rejected:** GitHub Actions cron (not our GitLab host, timing drift); AWS/GCP (setup time)
- **Risk mitigation:** Protected CI variables for `RAILWAY_TOKEN` (D-051); services are stateless except ops-agent drafts (JSON file on volume)

### GitLab CI (self-hosted, shared runners)
- **Why:** Repo host; GitLab CI natural choice; `glab` CLI for MR operations (D-016)
- **Alternatives rejected:** GitHub Actions (would require repo move); CircleCI (extra service)
- **Risk mitigation:** Protected/masked CI variables for secrets; Paawan reviews all `.gitlab-ci.yml` changes (D-051); timeout + retry policies (operator-rules §5)

## Testing & Development

### Vitest + fast-check (TS), pytest + hypothesis (Python)
- **Why:** Property-based testing for numeric/financial logic (D-017, D-031); deterministic edge-case discovery
- **Alternatives rejected:** Jest (Vitest is faster, native ESM); only example-based tests (insufficient for invariants)
- **Risk mitigation:** Coverage floors enforced (80% lines for TS/Python packages, success+failure paths for every program instruction, D-031)

### Playwright (UI smoke tests)
- **Why:** End-to-end browser tests for the four trade intents against local validator (D-017, M2-13)
- **Alternatives rejected:** Cypress (less modern); manual testing only (not reproducible in CI)
- **Risk mitigation:** Tests run against test wallet (injected), never real funds; local validator only

### proptest (Rust property tests)
- **Why:** Property-based testing for the matching engine (`crates/meridian-book`) and program invariants (D-017)
- **Alternatives rejected:** Only example-based tests (insufficient for order-matching edge cases)
- **Risk mitigation:** Shrinking finds minimal failing cases; combined with LiteSVM for full program invariant tests

## Security & Compliance

### gitleaks (v8.30.1)
- **Why:** Prevents committing secrets (AB-17); scans all commits in CI
- **Alternatives rejected:** Manual review only (error-prone); other secret scanners (gitleaks is standard, fast)
- **Risk mitigation:** CI fails on any leak; `.gitleaks.toml` configures patterns; tested against known secret patterns

### cargo-audit, pip-audit, pnpm audit
- **Why:** NFR-10 / AB-16 dependency vulnerability scanning; CI fails on high/critical advisories
- **Alternatives rejected:** No scanning (unacceptable); Snyk/Dependabot (extra service, not needed)
- **Risk mitigation:** Ignores limited to documented cases (LiteSVM dev-deps D-047, Solana 2.1 upstream warnings OQ-7); overrides patch vulnerabilities where possible (D-037, D-046)

## Summary

All major dependencies are either:
1. **PRD-specified** (Solana, Anchor, Next.js, React, TypeScript, Python): chosen by PEAK6
2. **Standard for ecosystem** (SPL Token, wallet-adapter, Switchboard for Solana oracles): no viable alternative
3. **Justified by requirement** (Anthropic for differentiator C; Recharts for distribution chart; property-test libraries for invariants)
4. **Operator-chosen within PRD constraints** (pnpm/uv over npm/pip for speed + safety; LiteSVM over validator-only tests for speed)

No dependency was added without a logged decision (D-001 to D-053) or a ticket requirement (M1-M3). Risky or novel choices (own CLOB D-002, Switchboard over Pyth D-005, UI pass without component library D-048) were human-approved.
