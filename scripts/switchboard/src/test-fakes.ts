// Test doubles shared by the unit tests (no network).
import { Keypair } from "@solana/web3.js";

import { DEVNET_QUEUE, type FetchedUpdate, type SwitchboardClient } from "./devnet";
import type { FeedDefinition } from "./feeds";
import { computeFeedHash } from "./spike";

/** Fake client; each method can be overridden per test. */
export function fakeClient(
  overrides: Partial<SwitchboardClient> = {},
  hashedDef?: FeedDefinition,
): SwitchboardClient {
  const update: FetchedUpdate = {
    ixs: [],
    luts: [],
    oracles: [{ oracle: "o1", value: "254.43", error: null }],
  };
  return {
    storeJobs: () => Promise.resolve("0x00"),
    createFeed: () => Promise.resolve(Keypair.generate().publicKey.toBase58()),
    feedHashOf: () =>
      Promise.resolve(hashedDef === undefined ? "" : computeFeedHash(DEVNET_QUEUE, hashedDef)),
    fetchUpdate: () => Promise.resolve(update),
    simulate: () => Promise.resolve({ slot: 99, error: null }),
    ...overrides,
  };
}
