// Helpers for the local-validator tests: a throwaway validator, a devnet build under a
// throwaway program ID (like scripts/e2e.sh) and the restore of every tracked file touched.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROGRAM_SRC = "programs/meridian/src/lib.rs";
const ANCHOR_TOML = "Anchor.toml";
const BUILD_KEYPAIR = join(REPO_ROOT, "target", "deploy", "meridian-keypair.json");

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

/** Restores the two tracked files `anchor keys sync` rewrites, and removes the build keypair. */
export function restoreTrackedFiles(): void {
  try {
    run("git", ["checkout", "--", PROGRAM_SRC, ANCHOR_TOML]);
  } finally {
    rmSync(BUILD_KEYPAIR, { force: true });
  }
}

/** Throws unless the two files `anchor keys sync` rewrites are committed and unmodified. */
export function assertTrackedFilesClean(): void {
  try {
    run("git", ["diff", "--quiet", "HEAD", "--", PROGRAM_SRC, ANCHOR_TOML]);
  } catch {
    throw new Error(`${PROGRAM_SRC} or ${ANCHOR_TOML} has uncommitted changes; commit them first`);
  }
}

/** `git status` for tracked files only; compared before and after to prove nothing leaked. */
export function trackedStatus(): string {
  return run("git", ["status", "--porcelain", "--untracked-files=no"]);
}

/**
 * Builds the devnet program under a throwaway program ID: `anchor keys sync` rewrites
 * `declare_id!` and Anchor.toml, then `make build-devnet`. The throwaway keypair is copied to
 * `keypairPath`. The caller must call `restoreTrackedFiles()` afterwards.
 */
export function buildDevnetUnderThrowawayId(keypairPath: string): PublicKey {
  assertTrackedFilesClean();
  mkdirSync(dirname(BUILD_KEYPAIR), { recursive: true });
  run("solana-keygen", ["new", "--no-bip39-passphrase", "-s", "--force", "-o", BUILD_KEYPAIR]);
  run("anchor", ["keys", "sync"]);
  run("make", ["build-devnet"]);
  copyFileSync(BUILD_KEYPAIR, keypairPath);
  const id = run("solana-keygen", ["pubkey", BUILD_KEYPAIR]).trim();
  rmSync(BUILD_KEYPAIR, { force: true });
  return new PublicKey(id);
}

/** Restores tracked files if the test process is interrupted. */
export function restoreOnExit(): void {
  const restore = () => {
    try {
      restoreTrackedFiles();
    } catch {
      // best effort on the way out
    }
  };
  process.on("exit", restore);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      restore();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
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
