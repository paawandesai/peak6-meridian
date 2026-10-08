import { AnchorProvider, BorshInstructionCoder, Wallet } from "@coral-xyz/anchor";
import { createMeridianProgram, findConfigPda, MERIDIAN_IDL, symbolBytes } from "@meridian/client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  CENTS_TO_SCALED,
  localOracleAdapter,
  redactSecrets,
  sdkFeedUpdater,
  selectAdapter,
  switchboardAdapter,
  type UpdateClient,
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

describe("sdkFeedUpdater (the real Switchboard path, with a fake client)", () => {
  const feed = Keypair.generate().publicKey;
  const overrides = {
    TIINGO_API_KEY: "dummy-dummy-1",
    TWELVEDATA_API_KEY: "dummy-dummy-2",
  };
  const oracle = (error: string | null) => ({
    oracle: "O1",
    value: error === null ? "681.25" : null,
    error,
  });

  it("returns the signed instructions and passes the keys only as overrides", async () => {
    const fx = loadUpdateFixture();
    const seen: Record<string, string>[] = [];
    const client: UpdateClient = {
      fetchUpdate: async (f, o) => {
        seen.push(o);
        return {
          ...(await fx.fetchUpdate(f)),
          ixs: [...(await fx.fetchUpdate(f)).ixs],
          luts: [fx.lookupTable],
          oracles: [oracle(null)],
        };
      },
    };
    const update = await sdkFeedUpdater({ client: () => Promise.resolve(client), overrides })(
      fx.feeds[0],
    );
    expect(update.ixs).toHaveLength(2);
    expect(update.luts).toEqual([fx.lookupTable]);
    expect(seen).toEqual([overrides]);
  });

  it("is an error, naming the oracles' reasons, when no oracle signed", async () => {
    for (const ixs of [undefined, []]) {
      const client: UpdateClient = {
        fetchUpdate: () =>
          Promise.resolve({ ixs, luts: [], oracles: [oracle("job failed"), oracle("timeout")] }),
      };
      const updater = sdkFeedUpdater({ client: () => Promise.resolve(client), overrides });
      await expect(updater(feed)).rejects.toThrow(
        /no oracle signed an update for feed .*: job failed; timeout/,
      );
    }
    const silent: UpdateClient = {
      fetchUpdate: () => Promise.resolve({ ixs: undefined, luts: [], oracles: [] }),
    };
    await expect(
      sdkFeedUpdater({ client: () => Promise.resolve(silent), overrides })(feed),
    ).rejects.toThrow(/no oracle responded/);
  });

  it("redacts the API keys and URLs from every error, whether from the oracles or the SDK", async () => {
    const echoing: UpdateClient = {
      fetchUpdate: () =>
        Promise.resolve({
          ixs: undefined,
          luts: [],
          oracles: [oracle("401 for https://api.tiingo.com/x?token=dummy-dummy-1")],
        }),
    };
    const throwing: UpdateClient = {
      fetchUpdate: () =>
        Promise.reject(
          new Error("fetch failed: header dummy-dummy-2 rejected by https://crossbar.example/v1"),
        ),
    };
    for (const client of [echoing, throwing]) {
      const message = await sdkFeedUpdater({ client: () => Promise.resolve(client), overrides })(
        feed,
      ).then(
        () => "resolved",
        (error: unknown) => String(error),
      );
      expect(message).not.toMatch(/dummy-dummy-[12]|https?:\/\//);
      expect(message).toContain("<url>");
    }
    // A failure to even build the client is handled the same way.
    const failing = sdkFeedUpdater({
      client: () => Promise.reject(new Error("boot failed with dummy-dummy-1")),
      overrides,
    });
    await expect(failing(feed)).rejects.not.toThrow(/dummy-dummy-[12]/);
  });

  it("redactSecrets ignores empty secrets", () => {
    expect(redactSecrets("abc abc", ["", "b"])).toBe("a[redacted]c a[redacted]c");
  });
});
