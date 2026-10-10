# M2-06/UI-04 Evidence Collection (Issue #45)

This directory contains evidence collection tests for deferred acceptance criteria from M2-06 AC5 and UI-04 AC5-AC6.

## Requirements

Evidence to be collected:
- Four trade intents (Buy YES market, Sell YES limit, Buy NO market, Sell NO limit) with before/after screenshots
- Confirmation timing < 3s for each trade
- 390px viewport validation
- Lighthouse accessibility report ≥ 90 for Trade page

## Running Locally

### Prerequisites
- Local-oracle build in `target/deploy` (run `make build-local`)
- Dependencies installed (`make install`)

### Evidence Collection Tests

```bash
# Run evidence collection tests (screenshots + timing)
pnpm --filter e2e run test:evidence
```

This runs `03-trade-evidence.spec.ts` which:
- Captures before/after screenshots for each of the four trade intents
- Measures and validates confirmation timing (< 3s)
- Tests 390px viewport validation
- Outputs screenshots to `tests/e2e/playwright-report/evidence/`
- Prints timing summary to console

### Lighthouse Accessibility Report

The Lighthouse test requires a **production build** of the app running with a market available:

```bash
# In one terminal: start validator and seed a market
cd tests/e2e
pnpm run lifecycle --cluster localnet --phase init-only
# Note the market address from output

# In another terminal: build and start production app
cd app
pnpm build
NEXT_PUBLIC_CLUSTER=localnet NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899 pnpm start

# In a third terminal: run one-off Lighthouse accessibility audit
npx lighthouse http://localhost:3000/trade/<market-address> \
  --only-categories=accessibility \
  --form-factor=mobile \
  --output=html \
  --output-path=./lighthouse-report.html
```

This generates a Lighthouse HTML report and validates accessibility ≥ 90. Quote the accessibility score in the MR or issue comment.

## CI Integration

### Manual Evidence Collection Job

A CI job can be added to `.gitlab-ci.yml` to run evidence collection:

```yaml
evidence:m2-06:
  stage: e2e
  needs: [build:local]
  tags: [heavy]
  resource_group: meridian-heavy
  rules:
    - when: manual
      allow_failure: true
  script:
    - pnpm --filter e2e run test:evidence
  artifacts:
    when: always
    paths:
      - tests/e2e/playwright-report/evidence/
    expire_in: 30 days
```

**Note:** `.gitlab-ci.yml` changes require Paawan review per operator rules.

## Artifacts

After running evidence collection, the following artifacts are generated:

### Screenshots (tests/e2e/playwright-report/evidence/)
- `buy-yes-before.png` - Trade form before Buy YES
- `buy-yes-after.png` - Confirmation after Buy YES
- `sell-yes-before.png` - Trade form before Sell YES  
- `sell-yes-after.png` - Confirmation after Sell YES
- `buy-no-before.png` - Trade form before Buy NO
- `buy-no-after.png` - Confirmation after Buy NO
- `sell-no-before.png` - Trade form before Sell NO
- `sell-no-after.png` - Confirmation after Sell NO
- `viewport-390px.png` - Trade page at 390px width

### Timing Data
Console output from test run includes:
```
=== Trade Confirmation Timings ===
Buy YES: XXXms
Sell YES: XXXms
Buy NO: XXXms
Sell NO: XXXms
Average: XXXms
```

### Lighthouse Report
- HTML report: `./lighthouse-report.html` (output from one-off `npx lighthouse` command)
- Accessibility score quoted in issue/MR comment

## Acceptance Criteria Reference

Evidence collected using this infrastructure must meet:
- **M2-06 AC5:** Four-intent run with screenshots, Lighthouse ≥ 90, 3s timing
- **UI-04 AC5:** Four intents with before/after screenshots and < 3s confirmation
- **UI-04 AC6:** 390px viewport validated

## Attaching Evidence to Issue #45

**This MR provides infrastructure only.** Evidence collection is a separate step.

Once evidence is collected locally or in CI:
1. Upload screenshot files to issue #45
2. Paste timing summary showing all < 3s
3. Attach Lighthouse HTML report and quote accessibility score ≥ 90
4. Confirm production build was used
5. Mark deferred M2-06 AC5 and UI-04 AC5-AC6 as complete in issue #45
