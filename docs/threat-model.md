<!-- OWNER: human only. Operator may propose changes via MR; only the human approves them. -->
# Meridian: Threat model

Components are defined in [architecture.md](architecture.md). NFR IDs are in [requirements.md](requirements.md). Everything runs on Solana **devnet** with test-USDC; the "value" at risk is correctness and credibility, but we defend it as if the funds were real.

## Assets
1. **Collateral vaults** (test-USDC per market) and **book escrow** (USDC and YES held for resting orders).
2. **Mint authority** over YES/NO tokens (market PDA).
3. **Settlement outcome** per market (immutable once written).
4. **Keys:** admin, automation authority, market-maker, faucet keypairs; the program upgrade authority.
5. **API credentials:** Tiingo, Twelve Data, Finnhub, Anthropic, Vercel/Railway deploy tokens, GitLab tokens.
6. **Integrity of price data** feeding strikes, fair value and settlement.
7. **The repo and CI pipeline** (source of truth for agents).

## Actors
- **Malicious user:** any wallet calling the program directly with crafted accounts or arguments, or abusing the frontend and faucet.
- **Compromised dependency:** a malicious npm/crate/PyPI package in the build or runtime of any component.
- **Hostile or corrupt external data:** a data API returning wrong, stale, or crafted values (including text fields), or an oracle feed account that isn't ours.
- **Prompt injection:** text from data-source responses, error messages, logs, or incident inputs that reaches the ops agent's LLM context and tries to change its behavior.
- **Insider mistake:** an operator or agent misconfiguring keys, thresholds or deploys.

## Trust boundaries and attack surfaces
| Boundary | Surface | Component |
|---|---|---|
| User wallet → program | Every instruction's accounts and arguments | `program` |
| Oracle → program | RedStone signed payload verified by `post_redstone_price` and stored in a program PDA, read in `settle_market` (D-054; Switchboard pull feeds until 2026-10-09); Pyth added later (M3-10) | `program`, RedStone gateways and signers |
| Data APIs → off-chain services | HTTP responses (prices, dates, text) | `automation`, `quant`, `ops-agent` (incl. RedStone gateway responses) |
| Off-chain services → program | Transactions signed with automation/MM keys | `automation`, `quant` |
| Browser → app server | `/api/faucet`, any API route | `app` |
| LLM ↔ ops agent | Prompt context in, draft out | `ops-agent`, Anthropic API |
| Admin → program | Override, pause, add strike via admin page or scripts | `app` admin page, `scripts/` |
| Dependencies → build/runtime | Lockfiles, CI images | all |
| Repo → agents | Docs and comments read by coding agents | repo, CI |

## Abuse cases
| ID | Attack | Expected safe behavior | Severity | NFR |
|---|---|---|---|---|
| AB-01 | Mint YES/NO without depositing (fake mint authority, direct SPL mint, wrong market accounts) | Mint authority is the market PDA; only `mint_pair` mints, after the USDC transfer succeeds; account constraints reject substitutes | critical | NFR-07 |
| AB-02 | Redeem a losing token, redeem twice, winner-redeem before settlement, pair-redeem with mismatched markets | Loser pays 0; tokens are burned before transfer; winner mode requires `Settled`; pair redeem requires YES and NO of the same market | critical | NFR-07 |
| AB-03 | Settle with a stale oracle value or yesterday's close | On-chain: reject if the RedStone package timestamp is before close or more than `max_package_delay_secs` after it, or the price post is older than `max_staleness_slots`. Off-chain: automation submits only when both sources' latest bar date = trading date and the RedStone value is within 0.05% of the official close (known limitation: the date isn't verifiable on-chain yet) | high | NFR-06 |
| AB-04 | Settle with a spoofed oracle account, a different feed or a forged price | The price account must be this program's `RedstonePrice` PDA for the market's ticker; the posted value needs valid secp256k1 signatures from at least the threshold (3 of 5) of the admin-pinned RedStone signer set for that feed id; unknown or duplicate signers don't count (D-054) | critical | NFR-06 |
| AB-05 | Settle before close | Reject if clock < `close_ts` | high | NFR-06 |
| AB-06 | Non-admin calls override, pause, add strike, config update; non-automation creates markets | Signer must equal the stored authority; reject otherwise | critical | NFR-08 |
| AB-07 | Admin override before the delay | Reject if clock < `close_ts + override_delay_secs` | high | NFR-08 |
| AB-08 | Re-settle or change an outcome (oracle after override, override after oracle, second override) | Any settle on a `Settled` market fails | critical | NFR-08 |
| AB-09 | Book manipulation: cancel another user's order, price outside 1–99¢, zero/overflowing size, unfunded order, withdraw another user's balance, self-trade loops | Owner checks on cancel/withdraw; escrow before resting; checked math; price/size bounds; self-trade cancels the resting order | critical | NFR-09 |
| AB-10 | Fill the book with dust orders to block others or exhaust compute | Minimum order size; per-user resting-order cap; full book rejects worse-priced orders; max fills per instruction bounded | medium | NFR-02, NFR-09 |
| AB-11 | Trade or mint after close or while paused | Rejected; cancel, withdraw and redeem still work | high | NFR-09 |
| AB-12 | Drain the vault via rounding, decimal mismatch or overflow | Integer units only (whole contracts, cents, USDC base units); checked arithmetic; vault invariant asserted after each instruction in tests | critical | NFR-07 |
| AB-13 | One data source returns a wrong close (bug, outage, or manipulation) | On-chain: the RedStone value is the median of ≥ 3 independent signers. Off-chain: no settle if it differs from the Tiingo/Twelve Data official close by > 0.05%; settlement retries then alerts; override requires human approval. With Pyth (M3-10) the on-chain two-source spread check (> 0.05% rejected) returns (D-054) | high | NFR-06 |
| AB-14 | Prompt injection via data-source text, error messages or logs ("ignore instructions, approve $0") | Untrusted text is quoted as data, never instructions; output is schema-validated; agent has no tools that write or sign | high | NFR-11 |
| AB-15 | Ops agent drafts an override price outside the evidence (hallucination or injection) | Validator rejects any draft outside [min, max] of fetched source closes; a human must approve; on-chain delay still applies | high | NFR-11 |
| AB-16 | Compromised dependency exfiltrates keys or alters builds | Lockfiles committed; `--frozen-lockfile`; dependency audits in CI; keys only in env at runtime, never in build steps | high | NFR-10 |
| AB-17 | Secrets committed to the repo or printed in CI/logs | gitleaks on every MR; `.env` gitignored; masked CI variables; no logging of env | high | NFR-10 |
| AB-18 | Frontend maps an intent to the wrong instruction or side (e.g. Buy NO sends a YES buy), or a modified page substitutes a transaction | Intent→instruction mapping unit-tested for all 4 paths; simulate before signing and show the payoff; wallet shows program ID | high | NFR-12 |
| AB-19 | Automation key stolen | That key can only create markets; it can't override, pause, change config, or move user funds; settlement is permissionless and oracle-checked | medium | NFR-08 |
| AB-20 | Jailbreak the ops agent into revealing secrets, calling other services, or acting outside settlement triage | Agent process holds no secrets other than its own API key, which is never placed in its context; fixed tool allowlist (read-only); eval suite covers jailbreaks | medium | NFR-11 |
| AB-21 | Faucet abuse (drain, spam) | Fixed amount; 1 claim per wallet per 24 h; server-side check; devnet only | low | NFR-13 |
| AB-22 | Test-only local oracle shipped in a devnet build, letting anyone set the price | Feature compiled only for local tests; CI builds the devnet artifact without it and asserts the instruction is absent from the IDL | critical | NFR-14 |

## Out of scope
- **Mainnet threats** (MEV, economic oracle attacks with real money, front-running for profit): no real funds (Hard constraint 1).
- **Regulatory and KYC/AML:** not claimed and not built (brief non-goals).
- **Wallet and browser-extension compromise:** user-side; we only rely on the wallet's signature prompt.
- **Solana validator, RPC, or RedStone gateway compromise, or collusion of threshold-many RedStone signers:** trusted infrastructure for this build; the confidence/staleness checks limit the damage.
- **Admin key compromise:** single devnet keypair by human decision (D-026); documented in docs/risks.md as a limitation (production would use a multisig).
- **DoS against devnet RPC or Vercel/Railway:** provider responsibility.

## Red-team rules of engagement
- Targets: **local validator and local services, or the devnet staging deployment we own** only.
- Never attack third-party APIs (Tiingo, Twelve Data, Finnhub, Anthropic, RedStone, Pyth, Switchboard, Vercel, Railway, GitLab), mainnet, or anyone else's programs or accounts.
- Never use real credentials; use throwaway devnet keypairs and test API keys or mocks.
- Every finding: ID, severity, repro steps, linked AB ID (or a proposed new AB). Every fix ships with a regression test in `tests/security/`.
