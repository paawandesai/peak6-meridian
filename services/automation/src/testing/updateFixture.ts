/** Loads `tests/fixtures/switchboard/update_ixs.json` as web3 objects (no network). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AddressLookupTableAccount, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";

import type { FeedUpdate, FetchFeedUpdate } from "../switchboard";

const PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../tests/fixtures/switchboard/update_ixs.json",
);

const instruction = z.object({
  programId: z.string(),
  keys: z.array(z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() })),
  data: z.string(),
});
const update = z.object({ feed: z.string(), ixs: z.array(instruction) });
const fixtureSchema = z.object({
  switchboardProgram: z.string(),
  lookupTable: z.object({ address: z.string(), addresses: z.array(z.string()) }),
  feeds: z.object({ tiingo: z.string(), twelveData: z.string() }),
  updates: z.object({ tiingo: update, twelveData: update }),
});

export interface UpdateFixture {
  readonly feeds: readonly [PublicKey, PublicKey];
  readonly switchboardProgram: PublicKey;
  readonly lookupTable: AddressLookupTableAccount;
  /** The recorded update for a fixture feed; throws for any other feed. */
  readonly fetchUpdate: FetchFeedUpdate;
  /** Every feed `fetchUpdate` was asked for, in order. */
  readonly requested: PublicKey[];
}

export function loadUpdateFixture(): UpdateFixture {
  const raw = fixtureSchema.parse(JSON.parse(readFileSync(PATH, "utf8")));
  const lookupTable = new AddressLookupTableAccount({
    key: new PublicKey(raw.lookupTable.address),
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: raw.lookupTable.addresses.map((a) => new PublicKey(a)),
    },
  });
  const toIxs = (ixs: z.infer<typeof instruction>[]): TransactionInstruction[] =>
    ixs.map(
      (ix) =>
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.keys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
          data: Buffer.from(ix.data, "base64"),
        }),
    );
  const byFeed = new Map<string, FeedUpdate>(
    [raw.updates.tiingo, raw.updates.twelveData].map((u) => [
      u.feed,
      { ixs: toIxs(u.ixs), luts: [lookupTable] },
    ]),
  );
  const requested: PublicKey[] = [];
  return {
    feeds: [new PublicKey(raw.feeds.tiingo), new PublicKey(raw.feeds.twelveData)],
    switchboardProgram: new PublicKey(raw.switchboardProgram),
    lookupTable,
    requested,
    fetchUpdate: (feed) => {
      requested.push(feed);
      const found = byFeed.get(feed.toBase58());
      if (found === undefined) {
        return Promise.reject(new Error("no recorded update for this feed"));
      }
      return Promise.resolve(found);
    },
  };
}
