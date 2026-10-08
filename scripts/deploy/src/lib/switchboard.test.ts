import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  FEED_HASH_OFFSET,
  feedAccountHash,
  isSwitchboardOwner,
  SWITCHBOARD_PROGRAM_IDS,
} from "./switchboard";

describe("switchboard helpers", () => {
  it("recognises both Switchboard program IDs and nothing else", () => {
    for (const id of SWITCHBOARD_PROGRAM_IDS) {
      expect(isSwitchboardOwner(id)).toBe(true);
    }
    expect(isSwitchboardOwner(PublicKey.default)).toBe(false);
  });

  it("reads the feed hash at the layout offset", () => {
    const data = new Uint8Array(3_208);
    data.fill(0xab, FEED_HASH_OFFSET, FEED_HASH_OFFSET + 32);
    expect(feedAccountHash(data)).toEqual(new Uint8Array(32).fill(0xab));
    expect(FEED_HASH_OFFSET).toBe(2_120);
  });

  it("returns null for an account too short to hold a hash", () => {
    expect(feedAccountHash(new Uint8Array(100))).toBeNull();
  });
});
