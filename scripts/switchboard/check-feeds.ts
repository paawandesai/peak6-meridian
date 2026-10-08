// Check the Switchboard feeds (M2-02): hashes, accounts, Config pins and the 0.05% source spread.
// Offline: `pnpm tsx scripts/switchboard/check-feeds.ts --dry-run`.
// Live (manual; funded devnet keypair, TIINGO_API_KEY/TWELVEDATA_API_KEY exported):
//   pnpm tsx scripts/switchboard/check-feeds.ts --feeds-file deployments/feeds.devnet.json
import { checkFeedsMain, consoleIo } from "./src/cli";

process.exitCode = await checkFeedsMain(process.argv.slice(2), process.env, consoleIo);
