## Ticket

<!-- Ticket ID and link, e.g. M1-04 · docs/tickets/M1.md#m1-04--mint-pair. Title the MR "M1-04: <ticket title>". -->

## What changed

<!-- What this MR does and why. If it touches files the ticket does not list, say why. -->

## Acceptance criteria

<!-- One line per acceptance criterion: how it was verified (command or test name) and the result. -->

- [ ] AC1:
- [ ] AC2:

## Decisions

<!-- Non-obvious technical choices: choice, why, alternatives, how to reverse. The operator logs them in docs/decisions.md. Write "None" if there are none. -->

## Checklist

- [ ] `make lint typecheck test test-security coverage` passes locally (`make e2e` too when `programs/`, `crates/`, `packages/client` or `scripts/` changed)
- [ ] Tests cover every acceptance criterion, including failure paths; no test deleted, skipped or weakened
- [ ] No secrets, keypairs or `.env` committed; no human-owned file changed (or the MR has the `human-approved` label)
- [ ] Pipeline: <!-- URL -->
