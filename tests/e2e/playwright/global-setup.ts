/**
 * Brings up the smoke stack and tears it down again: a `solana-test-validator` with the local-oracle
 * build, the lifecycle seed (config with local feeds, test-USDC, the day's markets open for 8 h),
 * a funded test wallet and the app (`next dev`) wired to the validator. Everything is throwaway and
 * local: the validator's keys never leave the temp dir and the app only gets them as env.
 *
 * Environment (optional): E2E_RPC_PORT (8899), E2E_FAUCET_PORT (9900), E2E_APP_PORT (3100),
 * E2E_APP_MODE (`dev`, the default, runs `next dev`; `production` runs `next build` then
 * `next start`, for evidence and Lighthouse runs that must measure the production bundle).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

import { STATE_ENV, type StackState } from "./support/state";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const PROGRAM_SO = join(ROOT, "target/deploy/meridian.so");
const PROGRAM_IDL = join(ROOT, "target/idl/meridian.json");
/** Trading date of tests/fixtures/prev_closes.json, which the lifecycle seed creates markets for. */
const SEED_TRADING_DATE = 20261006;

const RPC_PORT = Number(process.env.E2E_RPC_PORT ?? "8899");
const FAUCET_PORT = Number(process.env.E2E_FAUCET_PORT ?? "9900");
const APP_PORT = Number(process.env.E2E_APP_PORT ?? "3100");
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const APP_MODE = process.env.E2E_APP_MODE === "production" ? "production" : "dev";

const log = (message: string): void => console.log(`[playwright-setup] ${message}`);

function programIdFromAnchorToml(): string {
  const toml = readFileSync(join(ROOT, "Anchor.toml"), "utf8");
  const match = /^meridian = "(.+)"$/m.exec(toml);
  if (match?.[1] === undefined) throw new Error("no meridian program ID in Anchor.toml");
  return match[1];
}

function assertLocalBuild(): void {
  if (!existsSync(PROGRAM_SO) || !existsSync(PROGRAM_IDL)) {
    throw new Error(`missing ${PROGRAM_SO} or ${PROGRAM_IDL}: run \`make build-local\` first`);
  }
  // A devnet build has no local_oracle_set, so the redeem step could never settle (AB-22).
  if (!readFileSync(PROGRAM_IDL, "utf8").includes("local_oracle_set")) {
    throw new Error("target/ holds a devnet build (no local_oracle_set); run `make build-local`");
  }
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} not ready after ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

function stop(child: ChildProcess | undefined): void {
  if (child?.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  assertLocalBuild();
  const programId = programIdFromAnchorToml();
  const work = mkdtempSync(join(tmpdir(), "meridian-pw-"));
  const children: ChildProcess[] = [];
  const teardown = async (): Promise<void> => {
    for (const child of children) stop(child);
    rmSync(work, { recursive: true, force: true });
  };

  try {
    const connection = new Connection(RPC_URL, "confirmed");
    if (
      await connection.getVersion().then(
        () => true,
        () => false,
      )
    ) {
      throw new Error(`something is already serving ${RPC_URL}; stop it or set E2E_RPC_PORT`);
    }

    log(`starting solana-test-validator on ${RPC_URL}`);
    const validator = spawn(
      "solana-test-validator",
      [
        "--reset",
        "--quiet",
        "--ledger",
        join(work, "ledger"),
        "--bpf-program",
        programId,
        PROGRAM_SO,
        "--rpc-port",
        String(RPC_PORT),
        "--faucet-port",
        String(FAUCET_PORT),
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    children.push(validator);
    await until("validator", 120_000, async () => (await connection.getVersion(), true));

    const admin = Keypair.generate();
    const adminPath = join(work, "admin.json");
    writeFileSync(adminPath, JSON.stringify(Array.from(admin.secretKey)), { mode: 0o600 });
    const wallet = Keypair.generate();
    for (const [keypair, sol] of [
      [admin, 100],
      [wallet, 5],
    ] as const) {
      const signature = await connection.requestAirdrop(keypair.publicKey, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(signature, "confirmed");
    }

    log("seeding config, test-USDC and markets (lifecycle seed)");
    const seed = execFileSync("pnpm", ["--filter", "e2e", "run", "lifecycle"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ANCHOR_PROVIDER_URL: RPC_URL,
        ANCHOR_WALLET: adminPath,
        E2E_PROGRAM_ID: programId,
        E2E_SEED_ONLY: "1",
        E2E_CLOSE_IN_SECS: "28800",
      },
    });
    const usdcMint = /^SEED_USDC_MINT=(\S+)$/m.exec(seed)?.[1];
    if (usdcMint === undefined) throw new Error("the seed did not report the USDC mint");

    const appEnv = {
      ...process.env,
      NEXT_PUBLIC_CLUSTER: "devnet",
      NEXT_PUBLIC_RPC_URL: RPC_URL,
      NEXT_PUBLIC_PROGRAM_ID: programId,
      NEXT_PUBLIC_USDC_MINT: usdcMint,
      SOLANA_CLUSTER: "localnet",
      SOLANA_RPC_URL: RPC_URL,
      USDC_MINT: usdcMint,
      // The admin key is the throwaway mint authority of the seeded test-USDC.
      FAUCET_KEYPAIR: JSON.stringify(Array.from(admin.secretKey)),
      NEXT_TELEMETRY_DISABLED: "1",
    };
    const appLog = openSync(join(work, "app.log"), "a");
    if (APP_MODE === "production") {
      // NEXT_PUBLIC_* are inlined at build time, so the build runs after the seed knows the mint.
      log("building the app (next build, production)");
      try {
        execFileSync("pnpm", ["--filter", "app", "exec", "next", "build"], {
          cwd: ROOT,
          stdio: ["ignore", appLog, appLog],
          env: appEnv,
        });
      } catch (error) {
        const tail = readFileSync(join(work, "app.log"), "utf8").split("\n").slice(-25).join("\n");
        throw new Error(`next build failed: ${String(error)}\napp log (tail):\n${tail}`);
      }
    }
    log(`starting the app on ${APP_URL} (${APP_MODE})`);
    const app = spawn(
      "pnpm",
      [
        "--filter",
        "app",
        "exec",
        "next",
        APP_MODE === "production" ? "start" : "dev",
        "--port",
        String(APP_PORT),
      ],
      { cwd: ROOT, detached: true, stdio: ["ignore", appLog, appLog], env: appEnv },
    );
    children.push(app);
    // Warm the first compile so the specs do not pay for it; a non-2xx (for example a config
    // error) keeps waiting and the app log tail goes into the failure.
    await until("app", 300_000, async () => {
      const response = await fetch(APP_URL, { signal: AbortSignal.timeout(120_000) });
      return response.ok ? true : undefined;
    }).catch((error: unknown) => {
      const tail = readFileSync(join(work, "app.log"), "utf8").split("\n").slice(-25).join("\n");
      throw new Error(`${String(error)}\napp log (tail):\n${tail}`);
    });
    closeSync(appLog);

    const state: StackState = {
      rpcUrl: RPC_URL,
      appUrl: APP_URL,
      programId,
      usdcMint,
      adminKeypairPath: adminPath,
      walletSecret: Array.from(wallet.secretKey),
      tradingDate: SEED_TRADING_DATE,
    };
    const statePath = join(work, "state.json");
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    process.env[STATE_ENV] = statePath;
    log(
      `ready: program ${programId}, USDC mint ${usdcMint}, wallet ${wallet.publicKey.toBase58()}`,
    );
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
