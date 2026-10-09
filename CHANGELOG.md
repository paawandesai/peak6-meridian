# Changelog

All notable changes to Meridian will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
_To be filled from M1-M4 ticket review_

### Changed
_To be filled from M1-M4 ticket review_

### Fixed
_To be filled from M1-M4 ticket review_

### Security
_To be filled from security test findings_

## [1.0.0-devnet-submission] - TBD

Initial devnet submission for Gauntlet evaluation.

### Program
- Binary 0DTE outcome markets on MAG7 stocks
- On-chain order book with limit orders
- Switchboard oracle integration for settlement
- Admin controls with safety guardrails

### Services
- Morning market creation automation (TypeScript)
- Fair-value pricing service (Python)
- Market maker service (Python)
- Settlement oversight with Claude API (Python)

### Frontend
- Next.js 15 app with Markets, Trade, Portfolio, History, Admin pages
- Phantom/Solflare wallet integration
- Test-USDC faucet (1 claim per wallet per 24h)
- Real-time market data and position tracking

### Infrastructure
- GitLab CI/CD with comprehensive test gates
- Vercel deployment for frontend
- Railway deployment for backend services
- Fresh-clone reproducibility verified

### Known Limitations
_To be consolidated from docs/risks.md (M4-02)_

---

[Unreleased]: https://labs.gauntletai.com/paawandesai/peak6-meridian/-/compare/v1.0.0-devnet-submission...main
[1.0.0-devnet-submission]: https://labs.gauntletai.com/paawandesai/peak6-meridian/-/tags/v1.0.0-devnet-submission
