import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

const pubkeyText = z.string().refine(
  (value) => {
    try {
      new PublicKey(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "not a base58 public key" },
);

const envSchema = z.object({
  SOLANA_CLUSTER: z.string().min(1).optional(),
  SOLANA_RPC_URL: z.string().url(),
  ADMIN_KEYPAIR_PATH: z.string().min(1),
  PROGRAM_KEYPAIR_PATH: z.string().min(1),
  FAUCET_PUBKEY: pubkeyText,
  AUTOMATION_PUBKEY: pubkeyText,
  MERIDIAN_PROGRAM_ID: pubkeyText.optional(),
  USDC_MINT: pubkeyText.optional(),
  SWITCHBOARD_QUEUE: pubkeyText.optional(),
});

export const USAGE = `Usage: make deploy-devnet [DEPLOY_ARGS="--feeds <file> --out <file>"]

Deploys the devnet build of the Meridian program, creates the test-USDC mint and initialises
the Config; safe to re-run. Refuses any cluster whose genesis hash is not devnet.

Environment (public keys and key FILE PATHS only):
  SOLANA_RPC_URL        RPC endpoint (required)
  SOLANA_CLUSTER        "devnet" (default) or "localnet" (loopback URL only)
  ADMIN_KEYPAIR_PATH    admin keypair file: fee payer and upgrade authority (required)
  PROGRAM_KEYPAIR_PATH  program keypair file for the declared program ID (required)
  FAUCET_PUBKEY         test-USDC mint authority, public key (required)
  AUTOMATION_PUBKEY     automation authority, public key (required)
  MERIDIAN_PROGRAM_ID   optional extra check against the keypair
  USDC_MINT             optional existing mint to reuse (verified on chain)
  SWITCHBOARD_QUEUE     queue public key; needed with --feeds to verify feed hashes

Options:
  --out <file>      deployment record (default deployments/devnet.json)
  --feeds <file>    pin real feeds: { "AAPL": [{pubkey, hash}, {pubkey, hash}], ... }
  --queue <pubkey>  Switchboard queue (overrides SWITCHBOARD_QUEUE)
  --skip-build      do not run make build-devnet (use the existing target/ artifacts)
  --help
`;

export type Options = {
  readonly repoRoot: string;
  readonly rpcUrl: string;
  readonly solanaCluster: string | undefined;
  readonly adminKeypairPath: string;
  readonly programKeypairPath: string;
  readonly faucet: PublicKey;
  readonly automation: PublicKey;
  readonly meridianProgramId: string | undefined;
  readonly usdcMintEnv: PublicKey | undefined;
  readonly queue: PublicKey | undefined;
  readonly outPath: string;
  readonly feedsPath: string | undefined;
  readonly skipBuild: boolean;
};

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

/** Repo-relative paths resolve against the repository root, `~` against the home directory. */
function resolvePath(repoRoot: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(repoRoot, expanded);
}

/** Parses the environment and argv; throws a readable error listing every missing variable. */
export function parseOptions(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  repoRoot: string,
): Options | "help" {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: "string" },
      feeds: { type: "string" },
      queue: { type: "string" },
      "skip-build": { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help === true) {
    return "help";
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`invalid environment: ${problems.join("; ")}`);
  }
  const e = parsed.data;
  const queueText = values.queue ?? e.SWITCHBOARD_QUEUE;
  let queue: PublicKey | undefined;
  if (queueText !== undefined) {
    const check = pubkeyText.safeParse(queueText);
    if (!check.success) {
      throw new Error("--queue / SWITCHBOARD_QUEUE is not a base58 public key");
    }
    queue = new PublicKey(queueText);
  }
  return {
    repoRoot,
    rpcUrl: e.SOLANA_RPC_URL,
    solanaCluster: e.SOLANA_CLUSTER,
    adminKeypairPath: resolvePath(repoRoot, e.ADMIN_KEYPAIR_PATH),
    programKeypairPath: resolvePath(repoRoot, e.PROGRAM_KEYPAIR_PATH),
    faucet: new PublicKey(e.FAUCET_PUBKEY),
    automation: new PublicKey(e.AUTOMATION_PUBKEY),
    meridianProgramId: e.MERIDIAN_PROGRAM_ID,
    usdcMintEnv: e.USDC_MINT === undefined ? undefined : new PublicKey(e.USDC_MINT),
    queue,
    outPath: resolvePath(repoRoot, values.out ?? "deployments/devnet.json"),
    feedsPath: values.feeds === undefined ? undefined : resolvePath(repoRoot, values.feeds),
    skipBuild: values["skip-build"] === true,
  };
}
