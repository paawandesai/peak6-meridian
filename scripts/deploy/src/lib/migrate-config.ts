/**
 * Config migration (M3-10b): pure helpers behind `make migrate-config`. The v1 Config account
 * (1,076 bytes, created before the Pyth fields existed) grows to the v2 layout (1,144 bytes) with
 * the program's `migrate_config` instruction. The v2 fields were appended after `bump`, so the
 * v1 bytes must survive byte-for-byte; `verifyMigrated` checks exactly that.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { type ConfigParamsInput, type PythConfigInput, TICKER_COUNT } from "@meridian/client";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import type { OnChainConfig } from "./config-plan";

/** v1 Config size, discriminator included (the devnet account before M3-10b). */
export const CONFIG_V1_LEN = 1_076;
/** v2 Config size: v1 + the 68 bytes of Pyth fields. */
export const CONFIG_V2_LEN = 1_144;
/** Bytes appended by v2: signer (32) + 7 feed ids (4 each) + max age (8). */
export const PYTH_TAIL_LEN = CONFIG_V2_LEN - CONFIG_V1_LEN;
/** Anchor discriminator of `Config` (sha256("account:Config")[..8]). */
export const CONFIG_DISCRIMINATOR = Uint8Array.from([
  0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82,
]);
/** MAG7 Pyth Pro numeric feed ids in config slot order (programs/meridian/src/pyth). */
export const MAG7_PYTH_FEED_IDS: readonly number[] = [922, 1292, 1163, 954, 1314, 1272, 1435];
/** Default `pyth_max_age_secs` written when a signer is given without an explicit max age. */
export const DEFAULT_MIGRATION_MAX_AGE_SECS = 30n;

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
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_CLUSTER: z.enum(["devnet", "localnet"]).optional(),
  ADMIN_KEYPAIR_PATH: z.string().min(1),
  MERIDIAN_PROGRAM_ID: pubkeyText.optional(),
  DRY_RUN: z.string().optional(),
  PYTH_LAZER_SIGNER: pubkeyText.optional(),
  PYTH_FEED_IDS: z.string().optional(),
  PYTH_MAX_AGE_SECS: z.string().optional(),
});

export const MIGRATE_USAGE = `Usage: make migrate-config [DRY_RUN=1]

Grows the v1 Config account (1,076 bytes) to the current layout (1,144 bytes) with the admin-only
migrate_config instruction, then verifies every old byte is unchanged and the new fields are as
expected. Devnet (genesis-hash checked) or localnet (loopback URL) only. Safe to re-run: an
already-migrated account is verified and nothing is sent, unless PYTH_LAZER_SIGNER is given: then
the Pyth fields of the migrated account are set with update_config, every other field resent
unchanged from chain and verified afterwards (D-055 Pyth settlement runbook).

Environment (public keys and key FILE PATHS only):
  SOLANA_RPC_URL       RPC endpoint (required)
  SOLANA_CLUSTER       "devnet" (default) or "localnet" (loopback URL only)
  ADMIN_KEYPAIR_PATH   the Config admin's keypair file; pays the rent top-up (required)
  MERIDIAN_PROGRAM_ID  program id (default: the IDL address)
  DRY_RUN              1/true: read, check and simulate only; send nothing
  PYTH_LAZER_SIGNER    pin this Pyth Lazer signer now (default: leave the Pyth fields zero and
                       set them later with update_config)
  PYTH_FEED_IDS        7 comma-separated u32 feed ids in config slot order (default: MAG7 ids;
                       only with PYTH_LAZER_SIGNER)
  PYTH_MAX_AGE_SECS    positive integer (default 30; only with PYTH_LAZER_SIGNER)
`;

export type MigrateOptions = {
  readonly rpcUrl: string;
  readonly solanaCluster: "devnet" | "localnet" | undefined;
  readonly adminKeypairPath: string;
  readonly programId: PublicKey | undefined;
  readonly dryRun: boolean;
  /** `null`: migrate with the Pyth fields left zero. */
  readonly pyth: PythConfigInput | null;
};

function expandPath(path: string, repoRoot: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(repoRoot, expanded);
}

function parseFeedIds(text: string): number[] {
  const ids = text.split(",").map((part) => part.trim());
  if (ids.length !== TICKER_COUNT) {
    throw new Error(`PYTH_FEED_IDS must list ${TICKER_COUNT} ids, got ${ids.length}`);
  }
  return ids.map((id) => {
    if (!/^\d+$/.test(id) || Number(id) > 0xffff_ffff) {
      throw new Error(`PYTH_FEED_IDS entry is not a u32: "${id}"`);
    }
    return Number(id);
  });
}

function parseMaxAge(text: string): bigint {
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n || BigInt(text) > (1n << 63n) - 1n) {
    throw new Error(`PYTH_MAX_AGE_SECS must be a positive integer: "${text}"`);
  }
  return BigInt(text);
}

/** Parses the environment; throws a readable error naming every problem. */
export function parseMigrateOptions(
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): MigrateOptions {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`invalid environment: ${problems.join("; ")}`);
  }
  const e = parsed.data;
  if (e.PYTH_LAZER_SIGNER === undefined && (e.PYTH_FEED_IDS ?? e.PYTH_MAX_AGE_SECS) !== undefined) {
    throw new Error("PYTH_FEED_IDS / PYTH_MAX_AGE_SECS need PYTH_LAZER_SIGNER");
  }
  const pyth: PythConfigInput | null =
    e.PYTH_LAZER_SIGNER === undefined
      ? null
      : {
          lazerSigner: new PublicKey(e.PYTH_LAZER_SIGNER),
          feedIds:
            e.PYTH_FEED_IDS === undefined ? [...MAG7_PYTH_FEED_IDS] : parseFeedIds(e.PYTH_FEED_IDS),
          maxAgeSecs:
            e.PYTH_MAX_AGE_SECS === undefined
              ? DEFAULT_MIGRATION_MAX_AGE_SECS
              : parseMaxAge(e.PYTH_MAX_AGE_SECS),
        };
  const dry = (e.DRY_RUN ?? "").trim().toLowerCase();
  return {
    rpcUrl: e.SOLANA_RPC_URL,
    solanaCluster: e.SOLANA_CLUSTER,
    adminKeypairPath: expandPath(e.ADMIN_KEYPAIR_PATH, repoRoot),
    programId:
      e.MERIDIAN_PROGRAM_ID === undefined ? undefined : new PublicKey(e.MERIDIAN_PROGRAM_ID),
    dryRun: dry === "1" || dry === "true" || dry === "yes",
    pyth,
  };
}

/** The v1 prefix fields the script reports and checks (identical offsets in v2). */
export type ConfigPrefix = {
  readonly admin: PublicKey;
  readonly automationAuthority: PublicKey;
  readonly usdcMint: PublicKey;
  readonly paused: boolean;
  readonly maxStalenessSlots: bigint;
  readonly maxConfBps: number;
  readonly overrideDelaySecs: bigint;
  readonly bump: number;
};

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Decodes the v1 prefix by hand (works on a v1 or a v2 account). */
export function decodeConfigPrefix(data: Uint8Array): ConfigPrefix {
  if (data.length < CONFIG_V1_LEN) {
    throw new Error(`config account is ${data.length} bytes, shorter than v1 (${CONFIG_V1_LEN})`);
  }
  const dv = view(data);
  const key = (offset: number): PublicKey => new PublicKey(data.slice(offset, offset + 32));
  const bump = data[CONFIG_V1_LEN - 1];
  const paused = data[104];
  if (bump === undefined || paused === undefined) {
    throw new Error("unreachable: length checked above");
  }
  return {
    admin: key(8),
    automationAuthority: key(40),
    usdcMint: key(72),
    paused: paused !== 0,
    maxStalenessSlots: dv.getBigUint64(105, true),
    maxConfBps: dv.getUint16(113, true),
    overrideDelaySecs: dv.getBigUint64(115, true),
    bump,
  };
}

export type AccountState = "v1" | "v2";

/** Classifies the raw account; throws on a wrong owner, discriminator or size. */
export function classifyConfigAccount(
  data: Uint8Array,
  owner: PublicKey,
  programId: PublicKey,
): AccountState {
  if (!owner.equals(programId)) {
    throw new Error(
      `config account is owned by ${owner.toBase58()}, not the program ${programId.toBase58()}`,
    );
  }
  const discriminator = data.slice(0, 8);
  if (
    !discriminator.every((byte, i) => byte === CONFIG_DISCRIMINATOR[i]) ||
    discriminator.length !== 8
  ) {
    throw new Error("config account does not start with the Config discriminator");
  }
  if (data.length === CONFIG_V1_LEN) return "v1";
  if (data.length === CONFIG_V2_LEN) return "v2";
  throw new Error(
    `config account is ${data.length} bytes: neither v1 (${CONFIG_V1_LEN}) nor v2 (${CONFIG_V2_LEN})`,
  );
}

/** The 68 bytes `migrate_config` writes after `bump`: zeros, or the Pyth fields in order. */
export function expectedPythTail(pyth: PythConfigInput | null): Uint8Array {
  const tail = new Uint8Array(PYTH_TAIL_LEN);
  if (pyth === null) return tail;
  if (pyth.feedIds.length !== TICKER_COUNT) {
    throw new Error(`pyth feed ids must list ${TICKER_COUNT} slots`);
  }
  tail.set(pyth.lazerSigner.toBytes(), 0);
  const dv = view(tail);
  pyth.feedIds.forEach((id, i) => dv.setUint32(32 + 4 * i, id, true));
  dv.setBigInt64(32 + 4 * TICKER_COUNT, pyth.maxAgeSecs, true);
  return tail;
}

/** Lamports the admin must add so the grown account stays rent-exempt (0 if none). */
export function rentTopUp(requiredLamports: number, currentLamports: number): number {
  return Math.max(0, requiredLamports - currentLamports);
}

function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : length;
}

/**
 * Every problem with a migrated account: wrong size, any changed v1 byte (with its offset), a
 * tail that is not the expected Pyth bytes, or too few lamports. Empty when all is well.
 */
export function verifyMigrated(params: {
  readonly before: Uint8Array;
  readonly after: Uint8Array;
  readonly pyth: PythConfigInput | null;
  readonly lamports: number;
  readonly rentExemptLamports: number;
}): string[] {
  const { before, after, pyth, lamports, rentExemptLamports } = params;
  const problems: string[] = [];
  if (before.length !== CONFIG_V1_LEN) {
    problems.push(`the snapshot is ${before.length} bytes, not v1 (${CONFIG_V1_LEN})`);
  }
  if (after.length !== CONFIG_V2_LEN) {
    problems.push(
      `the account is ${after.length} bytes after migration, expected ${CONFIG_V2_LEN}`,
    );
  }
  const diff = firstDifference(before, after.slice(0, CONFIG_V1_LEN));
  if (diff !== -1) {
    problems.push(`old byte ${diff} changed during migration`);
  }
  const tailDiff = firstDifference(expectedPythTail(pyth), after.slice(CONFIG_V1_LEN));
  if (tailDiff !== -1) {
    problems.push(`new Pyth field byte ${CONFIG_V1_LEN + tailDiff} is not the expected value`);
  }
  if (lamports < rentExemptLamports) {
    problems.push(
      `the account holds ${lamports} lamports, below rent-exempt ${rentExemptLamports}`,
    );
  }
  return problems;
}

/**
 * `update_config` parameters that set only the Pyth fields of an already-migrated Config.
 * `update_config` overwrites every scalar field, so each is resent from chain; no ticker slot is
 * listed, so every slot keeps its value.
 */
export function pythUpdateParams(onChain: OnChainConfig, pyth: PythConfigInput): ConfigParamsInput {
  return {
    automationAuthority: onChain.automationAuthority,
    maxStalenessSlots: onChain.maxStalenessSlots,
    maxConfBps: onChain.maxConfBps,
    overrideDelaySecs: onChain.overrideDelaySecs,
    tickers: [],
    pyth,
  };
}

function describeTickers(config: OnChainConfig): string {
  return config.tickers
    .map(
      (t) =>
        `${t.symbol}:${t.feeds.map((f) => f.toBase58()).join("/")}:` +
        t.feedHashes.map((h) => Buffer.from(h).toString("hex")).join("/"),
    )
    .join(",");
}

/**
 * Everything wrong after a Pyth-only `update_config`: any non-Pyth field that changed, and any
 * Pyth field that is not what was asked. Empty when the update did exactly that.
 */
export function verifyPythUpdate(
  before: OnChainConfig,
  after: OnChainConfig,
  pyth: PythConfigInput,
): string[] {
  const problems: string[] = [];
  const same = (name: string, a: string, b: string): void => {
    if (a !== b) {
      problems.push(`${name} changed: ${a} -> ${b}`);
    }
  };
  same("admin", before.admin.toBase58(), after.admin.toBase58());
  same(
    "automation_authority",
    before.automationAuthority.toBase58(),
    after.automationAuthority.toBase58(),
  );
  same("usdc_mint", before.usdcMint.toBase58(), after.usdcMint.toBase58());
  same("max_staleness_slots", String(before.maxStalenessSlots), String(after.maxStalenessSlots));
  same("max_conf_bps", String(before.maxConfBps), String(after.maxConfBps));
  same("override_delay_secs", String(before.overrideDelaySecs), String(after.overrideDelaySecs));
  same("tickers", describeTickers(before), describeTickers(after));
  if (!after.pyth.lazerSigner.equals(pyth.lazerSigner)) {
    problems.push(`pyth_lazer_signer is ${after.pyth.lazerSigner.toBase58()}`);
  }
  if (after.pyth.feedIds.join(",") !== pyth.feedIds.join(",")) {
    problems.push(`pyth_feed_ids are ${after.pyth.feedIds.join(",")}`);
  }
  if (after.pyth.maxAgeSecs !== pyth.maxAgeSecs) {
    problems.push(`pyth_max_age_secs is ${after.pyth.maxAgeSecs}`);
  }
  return problems;
}
