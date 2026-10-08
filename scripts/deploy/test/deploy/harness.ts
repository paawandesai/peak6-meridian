// Helpers for the local-validator tests: a throwaway validator, a devnet build under a
// throwaway program ID (like scripts/e2e.sh) and the restore of every tracked file touched.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
/** Directories and files the isolated copy needs to build and test the program. */
const COPIED = [
  "programs",
  "crates",
  "tests/security/program",
  "tests/fixtures",
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

/**
 * `git status` plus `git diff` of tracked files, taken before and after a run and compared (never
 * an absolute state: a developer's working tree may be dirty) to prove nothing leaked.
 */
export function treeSnapshot(): string {
  return `${run("git", ["status", "--porcelain", "--untracked-files=no"])}\n${run("git", ["diff", "HEAD"])}`;
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

export type IsolatedCopy = {
  /** Root of the temporary copy (sources as in the working tree, uncommitted edits included). */
  readonly root: string;
  /** The throwaway program ID the copy was synced to. */
  readonly programId: PublicKey;
};

/** Copies the build inputs from the working tree into `root`. */
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
 * Prepares a temporary copy of the build inputs under a throwaway program ID, as scripts/e2e.sh
 * does: the throwaway keypair goes to the copy's `target/deploy/meridian-keypair.json` (the only
 * path `anchor keys sync` reads) and `anchor keys sync` rewrites `declare_id!`, Anchor.toml and
 * (at build time) the IDL address in the copy only. The copy keeps its own default `target/`,
 * so the real tree and its `target/` are never touched; it is removed on EXIT/INT/TERM and by
 * `removeDir`. The script itself builds in the copy (`buildDevnet`).
 */
export function prepareIsolatedCopy(root: string, keypairPath: string): IsolatedCopy {
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
  const keypair = join(root, "target", "deploy", "meridian-keypair.json");
  mkdirSync(dirname(keypair), { recursive: true });
  const inCopy = (command: string, args: string[]) =>
    execFileSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  inCopy("solana-keygen", ["new", "--no-bip39-passphrase", "-s", "--force", "-o", keypair]);
  inCopy("anchor", ["keys", "sync"]);
  copyFileSync(keypair, keypairPath);
  const programId = new PublicKey(inCopy("solana-keygen", ["pubkey", keypair]).trim());
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
  let lastError = "";
  // A port picked as free can be taken before the validator binds it: retry with new ports.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await startValidatorOnce(accounts);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`solana-test-validator did not start after 3 attempts: ${lastError}`);
}

async function startValidatorOnce(
  accounts: readonly { address: string; file: string }[],
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
  // Outside the ledger: `--reset` clears the ledger directory, including files placed in it.
  const output = `${ledger}.out`;
  const fd = openSync(output, "w");
  const child: ChildProcess = spawn("solana-test-validator", args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", fd, fd],
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const rpcUrl = `http://127.0.0.1:${rpc}`;
  const connection = new Connection(rpcUrl, "confirmed");
  const stop = async () => {
    if (!exited) {
      child.kill();
      await new Promise<void>((done) => {
        child.once("exit", () => done());
        setTimeout(done, 10_000);
      });
    }
    closeSync(fd);
    removeDir(ledger);
    rmSync(output, { force: true });
  };
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (exited || Date.now() > deadline) {
      const tail = readFileSync(output, "utf8").split("\n").slice(-8).join("\n");
      await stop();
      throw new Error(
        `${exited ? "validator exited during startup" : "validator not ready after 120 s"}: ${tail}`,
      );
    }
    try {
      await connection.getVersion();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { rpcUrl, connection, stop };
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
