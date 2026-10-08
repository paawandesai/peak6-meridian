import { AnchorProvider, BorshInstructionCoder, Wallet } from "@coral-xyz/anchor";
import { createMeridianProgram, findConfigPda, MERIDIAN_IDL, symbolBytes } from "@meridian/client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  CENTS_TO_SCALED,
  localOracleAdapter,
  selectAdapter,
  switchboardAdapter,
} from "./switchboard";
import { loadUpdateFixture } from "./testing";

describe("switchboardAdapter", () => {
  it("fetches one update per pinned feed, in feed order, and keeps each lookup table once", async () => {
    const fx = loadUpdateFixture();
    const built = await switchboardAdapter(fx.fetchUpdate).build({
      ticker: "META",
      closeCents: 68_000,
      feeds: fx.feeds,
      slot: 5,
    });
    expect(fx.requested.map((f) => f.toBase58())).toEqual(fx.feeds.map((f) => f.toBase58()));
    expect(built.ixs).toHaveLength(4);
    expect(built.luts).toHaveLength(1);
    expect(built.signers).toEqual([]);
    // The submit instruction of each feed names that feed.
    const submits = built.ixs.filter((ix) => ix.programId.equals(fx.switchboardProgram));
    expect(submits.map((ix) => ix.keys[0]?.pubkey.toBase58())).toEqual(
      fx.feeds.map((f) => f.toBase58()),
    );
  });

  it("never fetches a feed that is not one of the pinned two (AB-04)", async () => {
    const fx = loadUpdateFixture();
    const stranger = Keypair.generate().publicKey;
    await expect(
      switchboardAdapter(fx.fetchUpdate).build({
        ticker: "META",
        closeCents: 1,
        feeds: [fx.feeds[0], stranger],
        slot: 1,
      }),
    ).rejects.toThrow(/no recorded update/);
  });
});

describe("localOracleAdapter", () => {
  const admin = Keypair.generate();
  const program = createMeridianProgram(
    new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}),
  );
  const config = findConfigPda(program.programId).address;
  const feeds: [PublicKey, PublicKey] = [
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
  ];

  it("builds local_oracle_set for both source slots, signed by the injected admin only", async () => {
    const built = await localOracleAdapter({ program, config, admin }).build({
      ticker: "META",
      closeCents: 68_125,
      feeds,
      slot: 777,
    });
    expect(built.signers.map((s) => s.publicKey.toBase58())).toEqual([admin.publicKey.toBase58()]);
    expect(built.luts).toEqual([]);
    const coder = new BorshInstructionCoder(MERIDIAN_IDL);
    built.ixs.forEach((ix, slot) => {
      const decoded = coder.decode(Buffer.from(ix.data)) as {
        name: string;
        data: {
          ticker: number[];
          source_slot: number;
          value: { toString(): string };
          slot: { toString(): string };
        };
      } | null;
      expect(decoded?.name).toBe("local_oracle_set");
      expect(decoded?.data.ticker).toEqual(Array.from(symbolBytes("META")));
      expect(decoded?.data.source_slot).toBe(slot);
      expect(decoded?.data.value.toString()).toBe((68_125n * CENTS_TO_SCALED).toString());
      expect(decoded?.data.slot.toString()).toBe("777");
      // config, the pinned LocalFeed of that source slot, the admin as the only signer.
      expect(ix.keys.map((k) => k.pubkey.toBase58()).slice(0, 3)).toEqual([
        config.toBase58(),
        feeds[slot]?.toBase58(),
        admin.publicKey.toBase58(),
      ]);
      expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
        admin.publicKey.toBase58(),
      ]);
    });
  });
});

describe("selectAdapter (AB-22: the local oracle is unreachable off localnet)", () => {
  const sentinel = (kind: "local" | "switchboard") => ({
    kind,
    build: () => Promise.reject(new Error(kind)),
  });

  it("uses the local adapter only on localnet and never builds it on devnet", () => {
    let localBuilt = 0;
    const local = () => {
      localBuilt += 1;
      return sentinel("local");
    };
    expect(
      selectAdapter({ cluster: "localnet", local, switchboard: () => sentinel("switchboard") })
        .kind,
    ).toBe("local");
    expect(localBuilt).toBe(1);
    expect(
      selectAdapter({ cluster: "devnet", local, switchboard: () => sentinel("switchboard") }).kind,
    ).toBe("switchboard");
    expect(localBuilt).toBe(1);
  });
});
