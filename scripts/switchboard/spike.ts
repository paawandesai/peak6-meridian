// Switchboard devnet spike (M1-09). Offline: `pnpm tsx scripts/switchboard/spike.ts --dry-run`.
// Live (manual, keys required): `pnpm tsx scripts/switchboard/spike.ts --cluster devnet`.
import { consoleIo, spikeMain } from "./src/cli";

process.exitCode = await spikeMain(process.argv.slice(2), process.env, consoleIo);
