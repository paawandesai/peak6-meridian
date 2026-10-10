// M3-10b Config migration. Run it with `make migrate-config` (DRY_RUN=1 to simulate only).
// The implementation lives in the deploy package (scripts/deploy/src/migrate-config.ts), which
// owns the dependencies (@meridian/client, web3.js) and the unit tests of its pure helpers.
import "./deploy/src/migrate-config";
