// Generates tests/fixtures/switchboard/update_ixs.json: the instructions of one Switchboard
// On-Demand feed update (an Ed25519 signature-verify instruction plus the pull-feed submit
// instruction) for two feeds, and the address lookup table the SDK returns with them.
//
// PROVENANCE: synthetic, shaped like a recorded devnet update (account counts and data sizes
// follow what `PullFeed.fetchUpdateIx` returns for two oracle responses); a live recording is
// blocked on OQ-2/OQ-11 (data-API keys outside the sandbox). Replace the JSON with a real
// capture of the same shape when one exists. Deterministic: every key derives from a label.
//
//   pnpm exec tsx tests/fixtures/switchboard/generate_update_fixture.ts
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Keypair } from "@solana/web3.js";

const key = (label: string): string =>
  Keypair.fromSeed(
    createHash("sha256").update(`meridian-update-fixture:${label}`).digest(),
  ).publicKey.toBase58();
const bytes = (label: string, length: number): string => {
  const out = Buffer.alloc(length);
  let block = createHash("sha256").update(label).digest();
  for (let offset = 0; offset < length; offset += 32) {
    block.copy(out, offset, 0, Math.min(32, length - offset));
    block = createHash("sha256").update(block).digest();
  }
  return out.toString("base64");
};

const SWITCHBOARD_DEVNET = "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2";
const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";

// Accounts shared by every update; the SDK puts them in the lookup table.
const shared = [
  "queue",
  "state",
  "reward-vault",
  "token-program",
  "sysvar-slot-hashes",
  "sysvar-instructions",
  "oracle-a",
  "oracle-b",
].map(key);
const lookupTable = { address: key("lookup-table"), addresses: shared };

function updateFor(label: string, feed: string) {
  return {
    feed,
    ixs: [
      {
        programId: ED25519,
        keys: [],
        data: bytes(`${label}:ed25519`, 2 * (64 + 32 + 8 + 16) + 16),
      },
      {
        programId: SWITCHBOARD_DEVNET,
        keys: [
          { pubkey: feed, isSigner: false, isWritable: true },
          { pubkey: shared[0], isSigner: false, isWritable: false },
          { pubkey: shared[1], isSigner: false, isWritable: false },
          { pubkey: key("payer-placeholder"), isSigner: true, isWritable: true },
          { pubkey: SYSTEM, isSigner: false, isWritable: false },
          { pubkey: shared[2], isSigner: false, isWritable: true },
          { pubkey: shared[3], isSigner: false, isWritable: false },
          { pubkey: shared[4], isSigner: false, isWritable: false },
          { pubkey: shared[5], isSigner: false, isWritable: false },
          { pubkey: shared[6], isSigner: false, isWritable: false },
          { pubkey: shared[7], isSigner: false, isWritable: false },
        ],
        data: bytes(`${label}:submit`, 8 + 8 + 2 * 24 + 32),
      },
    ],
  };
}

const feeds = { tiingo: key("meta-tiingo-feed"), twelveData: key("meta-twelvedata-feed") };
const out = {
  note: "synthetic, shaped like a recorded devnet update; see generate_update_fixture.ts",
  switchboardProgram: SWITCHBOARD_DEVNET,
  lookupTable,
  feeds,
  updates: {
    tiingo: updateFor("tiingo", feeds.tiingo),
    twelveData: updateFor("twelvedata", feeds.twelveData),
  },
};
writeFileSync(resolve(import.meta.dirname, "update_ixs.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote update_ixs.json");
