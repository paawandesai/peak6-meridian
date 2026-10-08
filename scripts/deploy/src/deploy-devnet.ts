// Devnet deploy: program, test-USDC mint, config. See `make deploy-devnet` and --help.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { redactRpcUrl } from "@meridian/client";

import { runDeploy } from "./lib/deploy";
import { parseOptions, USAGE } from "./lib/options";

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const options = parseOptions(process.env, process.argv.slice(2), repoRoot);
  if (options === "help") {
    process.stdout.write(USAGE);
    return;
  }
  const { actions } = await runDeploy(options);
  process.stdout.write(
    actions.length === 0 ? "nothing to do: already deployed\n" : `done: ${actions.join(", ")}\n`,
  );
}

main().catch((error: unknown) => {
  // The message only: errors here never carry key material (see lib/keypair.ts).
  // Provider RPC URLs often carry an API key: redact before printing.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `deploy-devnet: ${redactRpcUrl(message, process.env.SOLANA_RPC_URL ?? "")}\n`,
  );
  process.exitCode = 1;
});
