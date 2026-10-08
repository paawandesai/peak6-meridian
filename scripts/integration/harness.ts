// Helpers for the local-validator tests: a throwaway validator, a devnet build under a
// throwaway program ID (like scripts/e2e.sh) and the restore of every tracked file touched.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Directories and files the isolated copy needs to build and test the program. */
const COPIED = [
  "programs",
  "crates",
  "tests/security/program",
  "tests/fixtures/switchboard",
  "oracle",
  "Cargo.toml",
  "Cargo.lock",
  "Anchor.toml",
  "rust-toolchain.toml",
  "rustfmt.toml",
  "clippy.toml",
  ".cargo",
];
const SKIPPED_NAMES = new Set(["target", "node_modules", ".git"]);

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(command, args, { cwd: REPO_ROOT, env, encoding: "utf8", maxBuffer: 1 << 28 });
}

/** Writes a keypair file (mode 600) in `dir` and returns its path. */
export function newKeypairFile(dir: string, name: string): { path: string; keypair: Keypair } {
  const keypair = Keypair.generate();
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return { path, keypair };
}

export function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `meridian-${label}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** `git status` for tracked files only; compared before and after to prove nothing leaked. */
export function trackedStatus(): string {
  return run("git", ["status", "--porcelain", "--untracked-files=no"]);
}

/** sha256 of a file, or null when it does not exist. */
export function sha256Of(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** The artifacts other suites use: the local-oracle build in the shared `target/`. */
export function sharedArtifactHashes(): Record<string, string | null> {
  return {
    so: sha256Of(join(REPO_ROOT, "target", "deploy", "meridian.so")),
    idl: sha256Of(join(REPO_ROOT, "target", "idl", "meridian.json")),
  };
}

/**
 * Where the isolated copy builds: its own cargo target directory, kept between runs under the
 * user cache so dependencies are not rebuilt every time (never the repository's `target/`).
 */
export function isolatedTargetDir(): string {
  return (
    process.env.MERIDIAN_DEPLOY_TEST_TARGET ??
    join(homedir(), ".cache", "meridian", "deploy-test-target")
  );
}

export type IsolatedBuild = {
  /** Root of the temporary copy (sources as in the working tree, uncommitted edits included). */
  readonly root: string;
  /** The throwaway program ID the copy was synced to. */
  readonly programId: PublicKey;
};

/** Copies the program sources from the working tree into `root`. */
function copySources(root: string): void {
  for (const entry of COPIED) {
    const from = join(REPO_ROOT, entry);
    if (existsSync(from)) {
      cpSync(from, join(root, entry), {
        recursive: true,
        filter: (source) => !SKIPPED_NAMES.has(basename(source)),
      });
    }
  }
}

/**
 * Builds the devnet program (`anchor build`, default features, no test oracle) in a temporary
 * copy of the sources with its own `CARGO_TARGET_DIR`, under a throwaway program ID
 * (`anchor keys sync`, as scripts/e2e.sh does). The real tree and its `target/` are never
 * touched. The throwaway keypair is written to `keypairPath`. The copy is removed on
 * EXIT/INT/TERM and by `removeIsolatedCopy`.
 */
export function buildDevnetInIsolatedCopy(root: string, keypairPath: string): IsolatedBuild {
  mkdirSync(root, { recursive: true });
  const cleanup = () => removeDir(root);
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanup();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
  copySources(root);
  // The copy's `target` is a link to the isolated cache, so `anchor keys sync` (which reads
  // target/deploy/meridian-keypair.json) and cargo both use the same directory.
  const targetDir = isolatedTargetDir();
  mkdirSync(join(targetDir, "deploy"), { recursive: true });
  symlinkSync(targetDir, join(root, "target"), "dir");
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, "target") };
  const keypair = join(targetDir, "deploy", "meridian-keypair.json");
  const inCopy = (command: string, args: string[]) =>
    execFileSync(command, args, { cwd: root, env, encoding: "utf8", maxBuffer: 1 << 28 });
  inCopy("solana-keygen", ["new", "--no-bip39-passphrase", "-s", "--force", "-o", keypair]);
  inCopy("anchor", ["keys", "sync"]);
  inCopy("anchor", ["build"]);
  copyFileSync(keypair, keypairPath);
  const programId = new PublicKey(inCopy("solana-keygen", ["pubkey", keypair]).trim());
  rmSync(keypair, { force: true });
  return { root, programId };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** An RPC port whose websocket neighbour (port + 1) is free too, and a faucet port. */
async function validatorPorts(): Promise<{ rpc: number; faucet: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rpc = await freePort();
    const neighbour = await new Promise<boolean>((done) => {
      const server = createServer();
      server.once("error", () => done(false));
      server.listen(rpc + 1, "127.0.0.1", () => server.close(() => done(true)));
    });
    if (neighbour) {
      return { rpc, faucet: await freePort() };
    }
  }
  throw new Error("no free validator ports");
}

export type Validator = {
  readonly rpcUrl: string;
  readonly connection: Connection;
  stop(): Promise<void>;
};

/** Starts `solana-test-validator` on free ports with the given account fixtures preloaded. */
export async function startValidator(
  accounts: readonly { address: string; file: string }[] = [],
): Promise<Validator> {
  const ledger = makeTempDir("ledger");
  const { rpc, faucet } = await validatorPorts();
  const args = [
    "--reset",
    "--quiet",
    "--ledger",
    ledger,
    "--bind-address",
    "127.0.0.1",
    "--rpc-port",
    String(rpc),
    "--faucet-port",
    String(faucet),
  ];
  for (const account of accounts) {
    args.push("--account", account.address, account.file);
  }
  const child: ChildProcess = spawn("solana-test-validator", args, {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const rpcUrl = `http://127.0.0.1:${rpc}`;
  const connection = new Connection(rpcUrl, "confirmed");
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (exited) {
      throw new Error("solana-test-validator exited during startup");
    }
    try {
      await connection.getVersion();
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error("solana-test-validator not ready after 120 s");
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return {
    rpcUrl,
    connection,
    async stop() {
      if (!exited) {
        child.kill();
        await new Promise<void>((done) => {
          child.once("exit", () => done());
          setTimeout(done, 10_000);
        });
      }
      removeDir(ledger);
    },
  };
}

/** Airdrops `sol` SOL to `pubkey` and waits for confirmation. */
export async function airdrop(connection: Connection, pubkey: PublicKey, sol: number) {
  const signature = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

/** Number of confirmed transactions that involved `pubkey` (an account-creation proxy). */
export async function signatureCount(connection: Connection, pubkey: PublicKey): Promise<number> {
  return (await connection.getSignaturesForAddress(pubkey, { limit: 1000 }, "confirmed")).length;
}
