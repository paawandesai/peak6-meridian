# M2-06/UI-04 Evidence (Issue #45)

Evidence for the ACs deferred from M2-06 AC5 and UI-04 AC5-AC6: the four trade intents run from the
Trade UI on a **local validator** against a **production build** (`next build` + `next start`),
with before/after screenshots, < 3 s confirmation timing, a 390 px viewport check and a Lighthouse
accessibility audit of Trade.

## Collected evidence (`tests/e2e/evidence/i45/`)

Recorded 2026-10-10 on `main` at 20312f2 + this harness. Local validator (solana-test-validator 2.1.21,
local-oracle build from `make build-local`), production app on port 3108, Chromium 390 x 844,
injected test wallet (Playwright-only, see "Wallet" below).

| File | What |
|---|---|
| `buy-yes-market-{before,after}.png` | Buy YES, market (worst price 60¢), 5 contracts |
| `sell-yes-limit-{before,after}.png` | Sell YES, limit 55¢, 5 contracts |
| `buy-no-market-{before,after}.png` | Buy NO, market (worst price 55¢), 3 contracts |
| `sell-no-limit-{before,after}.png` | Sell NO at a 30¢ limit price, 1 contract (see note) |
| `timings.md`, `timings.json` | Per-intent click -> "Confirmed in slot N" and click -> book updated, in ms |
| `viewport-390.png`, `viewport-390.json` | 390 px: all controls visible, `scrollWidth` = `clientWidth` = 390 |
| `lighthouse-trade-{mobile,desktop}.report.{json,html}` | Lighthouse 12.8.2, accessibility only |
| `lighthouse-summary.json` | URL and scores (mobile 100, desktop 100) |

Before screenshots show the resting maker order in the book and the simulated payoff above an
enabled sign button; after screenshots show "Confirmed in slot N" and the book without the filled
level. The "nothing would fill" line under the sign button in an after screenshot is the form
re-simulating the same order against the now-empty book, not a failure of the confirmed trade.

**Sell NO "limit":** domain.md defines Sell NO as `sell_no` = buy YES (IOC) + pair redeem, and the
Trade panel disables "Limit" for Sell NO ("Sell NO fills now or not at all; the price is your worst
price"). A Sell NO with a limit price is therefore the IOC order with the price field set (30¢ NO,
i.e. pay at most 70¢ YES); that is what the spec signs.

## Running it

Prerequisites: `make install`, `make build-local` (local-oracle `.so` and IDL in `target/`),
Node 22, Playwright's Chromium (`make e2e-ui-browser`), ports 8899/8900/9900 and the app port free.

```bash
cd tests/e2e
E2E_APP_MODE=production E2E_APP_PORT=3108 E2E_LIGHTHOUSE=1 \
  pnpm exec playwright test --config playwright-evidence.config.ts
```

- `global-setup.ts` starts `solana-test-validator`, runs the lifecycle seed with throwaway keypairs
  in a temp dir (no `~/.config/solana/id.json` needed), then `next build` + `next start` when
  `E2E_APP_MODE=production` (default `next dev`). Everything is torn down after the run.
- The Trade page lists only session markets (close at the session's ET close, P0-1), so the spec
  creates META's ladder for the next open session with the create-markets CLI (`--date`, no
  `--close-in-secs`) and trades the $680 strike.
- `E2E_LIGHTHOUSE=1` adds the one-off `npx --yes lighthouse@12.8.2` audit (mobile, then
  `--preset=desktop`) with Playwright's Chromium. Nothing is added to `package.json`.
- `E2E_EVIDENCE_DIR` overrides the output directory.

## Wallet

The browser wallet is the Wallet Standard test wallet in `playwright/support/wallet.ts`, injected
by Playwright (`page.addInitScript` + `page.exposeFunction`) so the app's real wallet-adapter path
runs with no extension. Signing happens in the Node test process with a throwaway local keypair.
No app code or `NEXT_PUBLIC_*` flag is involved, so nothing test-only can ship to Vercel.

## Acceptance criteria reference

- **M2-06 AC5:** four intents succeed from the UI on the local validator, with screenshots.
- **M2-06 AC4 / UI-04 AC5:** Lighthouse accessibility >= 90 on Trade; 390 px.
- **UI-04 AC6:** a confirmed tx shows in the book within 3 s on the local validator (NFR-01).
