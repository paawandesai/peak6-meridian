# Meridian: Risks and Limitations

**Status:** Devnet demonstration only. Not for production use. No real money involved.

This document describes known limitations, residual risks, and out-of-scope threats for the Meridian prediction market system. For technical details on security controls and attack mitigation, see [threat-model.md](threat-model.md). For architecture and design decisions, see [architecture.md](architecture.md) and [decisions.md](decisions.md).

## 1. Known Limitations

Meridian is a **devnet demonstration** with the following limitations:

### Deployment Scope
- **Devnet only:** Deployed on Solana devnet with test-USDC. No mainnet deployment, no real money, no financial value at risk (Hard constraint 1 from [brief.md](brief.md)).
- **Test USDC:** Uses a test SPL token mint with no real-world value. Faucet provides unlimited test-USDC for demonstration purposes.
- **Infrastructure dependencies:** Relies on Solana devnet RPC, Switchboard On-Demand network, and third-party data providers (Tiingo, Twelve Data, Finnhub). Any of these services may experience downtime or degradation.

### Access Control
- **Single admin key:** Admin functions (pause, unpause, add strikes, configure parameters, settle with override) are controlled by a single keypair (decision D-026). **Production systems should use a multisig or governance mechanism.** Admin key compromise allows pausing the system, adding strikes, and overriding settlement (after the delay), but cannot steal user funds or mint tokens without collateral.
- **Single automation key:** Market creation and automated settlement use a single automation authority keypair. This key can create markets but cannot override settlement, pause the system, or access user funds (AB-19).
- **Single market-maker key:** The market-maker service runs with a single keypair. Compromise allows unauthorized trading but not theft of other users' funds.

### Regulatory and Compliance
- **No KYC/AML:** The system does not implement know-your-customer or anti-money-laundering controls. This is acceptable for a devnet demonstration but would be required for any production deployment handling real funds.
- **No regulatory compliance:** This is a technical demonstration, not a licensed financial service. **We make no claims of regulatory compliance, approval, or authorization.** Users must comply with applicable laws in their jurisdiction.
- **No financial advice:** Nothing in this system constitutes financial, investment, legal, or tax advice.

### Settlement and Oracles
- **Oracle date verification limitation:** The on-chain settlement checks oracle value staleness and spread between two sources, but cannot verify that the oracle value's bar date matches the market's trading date. The automation service performs this check off-chain before submitting settlement (AB-03 known limitation per [threat-model.md](threat-model.md)).
- **Switchboard dependency:** Settlement requires Switchboard On-Demand oracles to be available and functioning. Oracle outages delay settlement until the ops-agent override path completes (automation retries for 15 minutes, then triggers ops-agent investigation and admin override after the delay).
- **Data source availability:** Fair value calculations, strike generation, and oracle feeds depend on third-party data providers (Tiingo, Twelve Data, Finnhub). Outages or API quota limits may delay morning market creation or settlement.

### Capacity and Scale
- **Limited book capacity:** Each market's order book holds 32 orders per side. When full, new orders must beat the worst resting order to be accepted ([domain.md](domain.md) § Order book rules).
- **Per-user order limit:** Maximum 8 resting orders per user per market. This prevents book spamming but limits complex trading strategies (AB-10 mitigation).
- **Devnet throughput:** Solana devnet may experience congestion, rate limits, or degraded performance compared to mainnet. The system is not optimized for high-frequency trading.

### Operational Limitations
- **Manual failover:** If the automation service fails (Railway outage, depleted SOL balance, or other issues), markets must be created manually using Fallback B (see [runbook.md](runbook.md)). Settlement can be triggered manually with the `settle-now` command (M2-04), but the ops-agent override path requires the service to be running.
- **Ops-agent budget cap:** The ops-agent has a configurable spend cap on LLM API calls (`OPS_AGENT_BUDGET_USD`, default $20). After exhaustion, the agent uses a deterministic fallback (median of source closes with no narrative); admin override still functions but without AI-generated investigation notes.

## 2. Residual Risks

These risks remain even with mitigations in place:

### High Severity

**Admin key compromise (AB-06, AB-07, AB-08 out of scope per [threat-model.md](threat-model.md)):**
- **Risk:** If the admin keypair is stolen or leaked, an attacker can pause the system (blocking trades), add arbitrary strikes, and settle markets with an override price (after the `override_delay_secs` delay, default 1 hour).
- **Mitigation in place:** Admin key stored outside the repo at `~/.config/meridian/` (never committed), gitleaks scans on every MR (AB-17), single human custodian with secure key management.
- **Residual exposure:** Single point of failure. An attacker gaining access to the operator's machine or key storage could compromise the admin key.
- **Accepted for devnet demo because:** This is a demonstration with test funds only. A production system would use a multisig (e.g., Squads Protocol) or on-chain governance to distribute admin authority across multiple parties.

**Data source outages or price manipulation (AB-13):**
- **Risk:** If both Tiingo and Twelve Data simultaneously provide incorrect close prices (due to bugs, outages, or upstream data corruption), and the values agree within 5 bps, the oracle would accept the wrong price and settle markets incorrectly.
- **Mitigation in place:** Dual-source oracle (two independent data providers), on-chain confidence check (max 5 bps spread), automation retry logic (15 minutes), ops-agent investigation with human oversight for overrides.
- **Residual exposure:** Coordinated failure or manipulation of both sources within the confidence threshold could result in incorrect settlement. The ops-agent reviews source data but relies on the same providers.
- **Accepted for devnet demo because:** Collusion or coordinated failure of both Tiingo and Twelve Data is unlikely for devnet test data. Production systems should add a third independent source and/or human spot-checks for high-value markets.

**Solana or Switchboard infrastructure failure (out of scope per [threat-model.md](threat-model.md)):**
- **Risk:** Solana devnet or Switchboard On-Demand network outages, consensus failures, or state rollbacks could delay settlement, cause transaction failures, or in extreme cases corrupt on-chain state.
- **Mitigation in place:** Automation retries with exponential backoff, alerts on repeated failures, ops-agent override path for settlement failures.
- **Residual exposure:** No control over devnet stability or Switchboard availability. Prolonged outages could delay settlement beyond acceptable windows.
- **Accepted for devnet demo because:** Devnet is a testing environment with expected instability. Production deployment would require SLAs with RPC providers and potentially a validator set under our control.

### Medium Severity

**Automation key compromise (AB-19):**
- **Risk:** Theft of the automation authority keypair allows an attacker to create arbitrary markets at any time.
- **Mitigation in place:** The automation key cannot settle markets (settlement is permissionless and oracle-checked), cannot pause or configure the system, and cannot access user funds. Market creation is rate-limited by the account rent cost and transaction fees.
- **Residual exposure:** Spam markets could clutter the UI and confuse users, but cannot steal funds or corrupt settlement.
- **Accepted for devnet demo because:** Market spam is low-impact on devnet. Production systems should implement market creation allowlists or governance approval for new tickers.

**LLM hallucination in ops-agent drafts (AB-15):**
- **Risk:** The ops-agent's LLM could hallucinate an override price outside the range of actual source data, or be manipulated via prompt injection (AB-14).
- **Mitigation in place:** Validator rejects any draft with `proposed_price_cents` outside `[min, max]` of the fetched source closes. Agent has no tools that sign transactions or write on-chain state. Human admin must review and approve every override. On-chain delay (`override_delay_secs`, default 1 hour) provides a window to catch errors.
- **Residual exposure:** If the admin approves a bad draft without verifying source data, the incorrect price could settle the market. The delay provides time but does not prevent human error.
- **Accepted for devnet demo because:** Test-USDC stakes are zero real value, and the override path is an infrequent exception case. Production systems should require multi-signature approval for overrides or integrate additional verification.

### Low to Medium Severity

**Faucet abuse (AB-21):**
- **Risk:** Users could create many wallets to repeatedly claim test-USDC from the faucet.
- **Mitigation in place:** 24-hour claim limit per wallet (enforced on-chain with marker accounts), fixed claim amount (1,000 USDC default), server-side rate limiting.
- **Residual exposure:** Sybil attacks with many wallets could drain faucet SOL balance (rent for marker accounts). Faucet key SOL exhaustion causes 503 errors.
- **Accepted for devnet demo because:** Test-USDC is valueless. The faucet is a convenience feature for demonstration, not a production necessity. SOL can be replenished easily via devnet airdrops.

**Dependency vulnerabilities (AB-16):**
- **Risk:** A compromised npm, PyPI, or Rust crate in the dependency tree could exfiltrate secrets or alter program behavior.
- **Mitigation in place:** Lockfiles committed, `--frozen-lockfile` installs, `cargo audit` / `pnpm audit` / `pip-audit` in CI, gitleaks scans. Keys only in environment variables at runtime, never in build artifacts.
- **Residual exposure:** Zero-day vulnerabilities in dependencies before audits detect them. Supply chain attacks on package registries.
- **Accepted for devnet demo because:** Devnet keys and test-USDC have no real value. Production systems should implement dependency pinning with hash verification, private package mirrors, and reproducible builds.

## 3. Out-of-Scope Threats

The following threats are explicitly out of scope for this devnet demonstration, per [threat-model.md](threat-model.md) § Out of scope:

- **Mainnet economic attacks:** MEV, oracle manipulation for profit, front-running, wash trading, or other economic exploits that rely on real financial value. This system uses test-USDC with no real-world value (Hard constraint 1).
- **Regulatory compliance:** KYC/AML, securities law compliance, licensing, or approval claims. This is a technical demonstration, not a regulated financial service.
- **Wallet and browser extension compromise:** User-side security is the user's responsibility. The system shows transaction previews and relies on the wallet's signature prompt to inform users, but cannot prevent malware on the user's device.
- **Solana validator, RPC, or Switchboard network compromise:** Infrastructure-level attacks (consensus manipulation, RPC man-in-the-middle, validator collusion) are outside the threat model. The system treats Solana devnet and Switchboard as trusted infrastructure.
- **Admin key compromise:** Decision D-026 accepts a single admin keypair for devnet. Production systems require multisig; devnet admin compromise is documented here as a known limitation, not defended against.
- **DoS attacks against devnet RPC or hosting providers:** Rate limiting and availability of Vercel (app), Railway (automation/quant/ops-agent), and devnet RPC are the providers' responsibility. The system implements retries and alerts but does not defend against network-layer DoS.

## 4. Mitigations in Place

The following controls mitigate the attack surface per [threat-model.md](threat-model.md) abuse cases (AB-01 through AB-22):

### On-Chain Program Defenses
- **Mint authority and vault controls (AB-01, AB-02, AB-12):** Only the `mint_pair` instruction can mint YES/NO tokens, and only after USDC transfer succeeds. Mint authority is the market PDA. Vault balance invariant (`vault = pairs_outstanding × 1 USDC`) is asserted in tests after every instruction. Integer arithmetic only (no floats), checked math (no overflows).
- **Access control (AB-06, AB-07, AB-08):** Admin and automation authority verified by signer checks. Override requires `clock ≥ close_ts + override_delay_secs`. Re-settlement rejected (outcome is immutable once written).
- **Oracle confidence and staleness checks (AB-03, AB-04, AB-05, AB-13):** Dual-source oracle (Tiingo + Twelve Data). On-chain settlement rejects if either feed is stale (`> max_staleness_slots`, default 30 slots ≈ 12 seconds), updated before close, or has a spread `> max_conf_bps` (default 5 bps). Feed accounts verified by Switchboard program ownership and pinned feed hash. Clock checked (`now ≥ close_ts`).
- **Book and trade safety (AB-09, AB-10, AB-11):** Owner checks on cancel and withdraw. Escrow before resting. Checked arithmetic. Price bounds [1, 99]. Minimum order size. Per-user resting order cap (8). Full book evicts worst-priced orders. Max fills per instruction bounded. Trading and minting rejected after close or during pause; cancel, withdraw, redeem always allowed.
- **Test oracle isolation (AB-22):** `local_oracle_set` instruction compiled only with `--features local-oracle`. Devnet builds exclude this feature. CI asserts the instruction is absent from the devnet IDL ([threat-model.md](threat-model.md) AB-22).

### Off-Chain Service Defenses
- **Ops-agent tool allowlist and validation (AB-14, AB-15, AB-20):** Agent has no signing capability. Tool allowlist is read-only: fetch source closes, read accounts, check calendar. No network access beyond HTTP to Tiingo/Twelve Data with keys in headers only (not in URLs). Draft validator rejects prices outside `[min, max]` of fetched closes. Draft validator rejects any note containing URLs or API keys (regex-based text check). Human admin must approve every override.
- **Automation retries and alerts (AB-03, AB-13):** Settlement retries every 30 seconds for 15 minutes on failure. After 15 minutes, one alert and one incident posted to ops-agent. Automation verifies both sources' latest bar date matches the market's trading date before submitting settlement (off-chain mitigation for AB-03 date limitation).
- **Secrets management (AB-16, AB-17):** Lockfiles committed. `--frozen-lockfile` installs. `cargo audit`, `pnpm audit`, `pip-audit` in CI. Gitleaks on every MR. `.env` gitignored. Masked CI variables. Logs never contain env values, tokens, or keypair contents. Keys stored outside the repo (`~/.config/meridian/`).
- **Frontend intent verification (AB-18):** Intent → instruction mapping unit-tested for all four trade paths (Buy YES, Sell YES, Buy NO, Sell NO). Transaction simulation before signing. Payoff sentence shown with amount and direction. Wallet adapter displays program ID.
- **Faucet rate limiting (AB-21):** On-chain 24-hour per-wallet claim limit (marker accounts). Fixed claim amount (default 1,000 USDC). Server-side checks. Faucet balance alerts when below threshold.

### Process and Operational Controls
- **Abuse-case tests (AB-01 through AB-22):** Every abuse case in [threat-model.md](threat-model.md) has a corresponding test in `tests/security/{program,ts,py}/` named `ab_XX_<description>`. Tests verify the expected safe behavior (rejection, error, constraint enforcement).
- **Code review:** Cursor AI reviewer checks every MR against [review.md](review.md) for security (secrets, input validation, account constraints, invariants). Human operator reviews all reviews and approves merges.
- **Coverage gates:** 80% line coverage floor for `crates/meridian-book`, each TS package, and each Python package. Program has no coverage gate but requires tests for every instruction's success and failure paths.
- **Property-based testing:** Financial and numeric logic (matching engine, strike calculation, P&L, unit conversions) tested with property-based frameworks (proptest, fast-check, hypothesis) to explore edge cases.

## 5. Disclaimer

**This is a demonstration system deployed on Solana devnet for educational and evaluation purposes only.**

### No Financial Services
- **Not an investment:** Meridian does not offer, solicit, or provide investment advice, financial advice, legal advice, or tax advice.
- **No real money:** All trading uses test-USDC with zero real-world value. No real funds are at risk.
- **Not a regulated service:** This system is not licensed, registered, approved, or endorsed by any financial regulator, securities commission, or government authority.
- **No compliance claims:** We make no claims of compliance with securities laws, commodities regulations, KYC/AML requirements, or any other regulatory framework.

### No Production Deployment
- **Devnet only:** This system is deployed on Solana devnet, a testing environment. It is not suitable for mainnet deployment or production use without substantial hardening, including but not limited to: multisig admin controls, additional oracle sources, governance mechanisms, regulatory compliance, security audits, and economic attack modeling.
- **No warranties:** The system is provided "as is" without warranties of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement.
- **No liability:** The authors and operators are not liable for any losses, damages, or costs arising from use of this system, including but not limited to: bugs, outages, data errors, oracle failures, key compromise, or user error.

### User Responsibility
- **Jurisdiction:** Users are responsible for compliance with all applicable laws and regulations in their jurisdiction. Some jurisdictions prohibit prediction markets, binary options, or online wagering. **Do not use this system if prohibited in your jurisdiction.**
- **No guarantees:** Settlement times, oracle accuracy, system availability, and data integrity are best-effort. No guarantees are made.
- **Educational purpose:** This system is intended for educational evaluation of Solana smart contract development, oracle integration, and prediction market mechanics. It is not intended for commercial use or real-money trading.

### Future Development
- **Devnet demonstration scope:** This demonstration implements core prediction market mechanics (order book, settlement, oracles, ops-agent triage) on devnet to illustrate technical feasibility and UX patterns.
- **Production requirements:** A production system would require: multisig or governance-controlled admin functions (D-026), additional independent oracle sources, economic security modeling, formal verification of critical invariants, professional security audits, regulatory compliance, KYC/AML integration, and real-money risk management.
- **No roadmap:** This document describes the current devnet demonstration. It does not constitute a roadmap, commitment, or plan for mainnet deployment or future development.

---

**Questions or issues?** See [threat-model.md](threat-model.md) for technical security details, [architecture.md](architecture.md) for system design, and [README.md](../README.md) for setup and usage instructions.
