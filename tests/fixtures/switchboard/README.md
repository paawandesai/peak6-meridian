# Switchboard fixtures

`pull_feed_meta_tiingo.json` is a `PullFeedAccountData` account (`solana account --output json`
shape): owner = Switchboard On-Demand devnet program, feed hash `0xab…ab`, value $681.25, slot
412345678, last update 301 s after the 2026-10-06 close. The program's oracle tests and the
`settlement` tests parse it; there is no network access.

**Provenance:** generated offline by `generate_fixture.py` from the struct layout of
`switchboard-on-demand` 0.13.x, not captured from a live feed. The live capture is blocked by
OQ-11 (M1-09); drop a real capture in with the same file name when it is available.

`update_ixs.json` holds the instructions of one Switchboard On-Demand feed update (Ed25519
signature verify + pull-feed submit, for the Tiingo and the Twelve Data feed of one ticker) and
the address lookup table that goes with them. **Provenance:** synthetic, produced by
`generate_update_fixture.ts` with the account counts and data sizes of a real two-oracle update;
a live recording is blocked on OQ-2/OQ-11. `services/automation` uses it to test the settlement
transaction builder (instruction order, pinned feeds, size fallbacks) with no network.
