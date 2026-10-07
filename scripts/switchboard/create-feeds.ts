// Create the Switchboard feeds on devnet (M1-09). Hashes only: `... create-feeds.ts --dry-run`.
// Live (manual, funded devnet keypair): `pnpm tsx scripts/switchboard/create-feeds.ts --cluster devnet`.
import { consoleIo, createFeedsMain } from "./src/cli";

process.exitCode = await createFeedsMain(process.argv.slice(2), process.env, consoleIo);
