# Switchboard fixtures

`pull_feed_meta_tiingo.json` is a `PullFeedAccountData` account (`solana account --output json`
shape): owner = Switchboard On-Demand devnet program, feed hash `0xab…ab`, value $681.25, slot
412345678, last update 301 s after the 2026-10-06 close. The program's oracle tests and the
`settlement` tests parse it; there is no network access.

**Provenance:** generated offline by `generate_fixture.py` from the struct layout of
`switchboard-on-demand` 0.13.x, not captured from a live feed. The live capture is blocked by
OQ-11 (M1-09); drop a real capture in with the same file name when it is available.
