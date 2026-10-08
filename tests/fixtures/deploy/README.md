# Deploy fixtures

`feeds.fixture.json` is the `--feeds` input used by the deploy script's tests: seven tickers with a
Tiingo and a Twelve Data feed each. Public data only.

- **pubkeys** are deterministic (`Keypair.fromSeed(sha256("meridian-deploy-fixture:<ticker>:<source>"))`,
  public half only); the validator-backed tests load `tests/fixtures/switchboard/pull_feed_meta_tiingo.json`
  as a Switchboard-owned account at each of these 14 addresses.
- **hashes** are `computeFeedHash(queue, definition)` over `oracle/feeds/*` for the fixed test queue
  pubkey below (32 bytes of `0x07`). The test passes it as `--queue`.

Queue pubkey: `US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx`

Regenerate with `pnpm --filter deploy exec tsx src/test-support/feeds-fixture.ts`; a unit test fails
when the committed file drifts from the generator.
