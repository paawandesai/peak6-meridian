// @vitest-environment node
import { BorshAccountsCoder, type AnchorProvider as AnchorProviderType } from "@coral-xyz/anchor";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  BN,
  createMeridianProgram,
  findConfigPda,
  MERIDIAN_IDL,
  symbolBytes,
} from "@meridian/client";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { createReader, fetchConfig, fetchMarkets, fetchUsdcBalance } from "./chain";
import { parsePublicConfig } from "./config";
import { OWNER } from "@/test-utils";

const num = (n: bigint | number) => ({ toString: () => n.toString() });

describe("fetchMarkets", () => {
  it("decodes on-chain accounts into rows", async () => {
    const rows = await fetchMarkets({
      all: () =>
        Promise.resolve([
          {
            publicKey: OWNER,
            account: {
              ticker: symbolBytes("MSFT"),
              tradingDate: 20260105,
              strikeCents: num(44_000n),
              closeTs: num(1_767_000_000n),
              pairsOutstanding: num(12n),
              status: { settled: {} },
              outcome: { yes: {} },
              settlePriceScaled: num(181_420_000_000_000_000_000n),
              settledAt: num(1_767_000_300n),
            },
          },
          {
            publicKey: OWNER,
            account: {
              ticker: symbolBytes("AAPL"),
              tradingDate: 20260105,
              strikeCents: num(22_000n),
              closeTs: num(1_767_000_000n),
              pairsOutstanding: num(0n),
              status: { open: {} },
              outcome: { none: {} },
              settlePriceScaled: num(0n),
              settledAt: num(0n),
            },
          },
        ]),
    });
    expect(rows[0]).toEqual({
      address: OWNER.toBase58(),
      ticker: "MSFT",
      tradingDate: 20260105,
      strikeCents: 44_000n,
      closeTs: 1_767_000_000n,
      settled: true,
      outcome: "Yes",
      settlePriceScaled: 181_420_000_000_000_000_000n,
      pairsOutstanding: 12n,
      settledAt: 1_767_000_300n,
    });
    expect(rows[1]?.settled).toBe(false);
    expect(rows[1]?.outcome).toBe("None");
  });

  it("propagates RPC failures", async () => {
    await expect(
      fetchMarkets({ all: () => Promise.reject(new Error("rpc down")) }),
    ).rejects.toThrow("rpc down");
  });
});

describe("fetchUsdcBalance", () => {
  const entry = (amount: string) => ({
    account: { data: { parsed: { info: { tokenAmount: { amount } } } } },
  });
  const connection = (value: unknown[]) => ({
    getParsedTokenAccountsByOwner: () => Promise.resolve({ context: { slot: 1 }, value }),
  });

  it("sums the owner's accounts in base units", async () => {
    const total = await fetchUsdcBalance(
      connection([entry("1500000"), entry("250000")]) as never,
      OWNER,
      OWNER,
    );
    expect(total).toBe(1_750_000n);
  });

  it("is zero without token accounts", async () => {
    expect(await fetchUsdcBalance(connection([]) as never, OWNER, OWNER)).toBe(0n);
  });

  it("rejects a malformed RPC response", async () => {
    await expect(fetchUsdcBalance(connection([{}]) as never, OWNER, OWNER)).rejects.toThrow();
  });
});

describe("createReader", () => {
  it("reports no balance when the mint is not configured", async () => {
    const reader = createReader(parsePublicConfig({}));
    expect(await reader.usdcBalance(new PublicKey(OWNER))).toBeNull();
  });
});

// ---- real serialized accounts (UI-02 AC7): bytes built from the IDL, read back through Anchor ----

const key = () => PublicKey.unique();
const accountCoder = new BorshAccountsCoder(MERIDIAN_IDL);

/** A `Market` account's bytes, encoded with the IDL (field names and variants as in the IDL). */
async function marketBytes(fields: {
  status: "Open" | "Settled";
  outcome: "None" | "Yes" | "No";
  settlePriceScaled: bigint;
  strikeCents?: bigint;
  closeTs?: bigint;
}): Promise<Buffer> {
  return accountCoder.encode("Market", {
    ticker: Array.from(symbolBytes("NVDA")),
    strike_cents: new BN((fields.strikeCents ?? 18_000n).toString()),
    trading_date: 20261008,
    close_ts: new BN((fields.closeTs ?? 1_791_492_000n).toString()),
    yes_mint: key(),
    no_mint: key(),
    vault: key(),
    escrow_usdc: key(),
    escrow_yes: key(),
    book: key(),
    pairs_outstanding: new BN(7),
    status: { [fields.status]: {} },
    outcome: { [fields.outcome]: {} },
    settle_price_scaled: new BN(fields.settlePriceScaled.toString()),
    settle_slot: new BN(5),
    settled_at: new BN(6),
    settle_source: { Oracle: {} },
    bump: 254,
  });
}

/**
 * A `Config` account's bytes. The IDL coder's default 1000-byte buffer is too small for Config,
 * so the (documented, fixed) layout is written by hand and then decoded by the real Anchor
 * program below, which fails if any offset disagrees with the IDL.
 */
function configBytes(paused: boolean, overrideDelaySecs: bigint, admin = key()): Buffer {
  const config = MERIDIAN_IDL.accounts?.find((account) => account.name === "Config");
  const parts: Buffer[] = [
    Buffer.from(config?.discriminator ?? []),
    admin.toBuffer(), // admin
    key().toBuffer(), // automation_authority
    key().toBuffer(), // usdc_mint
    Buffer.from([paused ? 1 : 0]),
  ];
  const u64 = (value: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value);
    return b;
  };
  parts.push(u64(30n)); // max_staleness_slots
  const bps = Buffer.alloc(2);
  bps.writeUInt16LE(5);
  parts.push(bps); // max_conf_bps
  parts.push(u64(overrideDelaySecs));
  for (let i = 0; i < 7; i += 1) {
    parts.push(Buffer.from(symbolBytes("AAPL")), Buffer.alloc(64), Buffer.alloc(64)); // ticker slot
  }
  parts.push(Buffer.from([253])); // bump
  // v2 (M3-10b): the Pyth fields are appended after `bump`.
  parts.push(key().toBuffer()); // pyth_lazer_signer
  for (let i = 0; i < 7; i += 1) {
    const feedId = Buffer.alloc(4);
    feedId.writeUInt32LE(0); // pyth_feed_ids[i]
    parts.push(feedId);
  }
  parts.push(u64(600n)); // pyth_max_age_secs
  return Buffer.concat(parts);
}

/** A real Anchor program whose connection serves the given account bytes. */
function programServing(accounts: { address: PublicKey; data: Buffer }[]) {
  const info = (data: Buffer) => ({
    data,
    owner: PublicKey.default,
    lamports: 1,
    executable: false,
  });
  const connection = {
    rpcEndpoint: "http://127.0.0.1:8899",
    commitment: "confirmed",
    getAccountInfo: (address: PublicKey) =>
      Promise.resolve(
        accounts.find((a) => a.address.equals(address)) === undefined
          ? null
          : info(accounts.find((a) => a.address.equals(address))?.data ?? Buffer.alloc(0)),
      ),
    getAccountInfoAndContext: (address: PublicKey) =>
      Promise.resolve({
        context: { slot: 1 },
        value: accounts.find((a) => a.address.equals(address))
          ? info(accounts.find((a) => a.address.equals(address))?.data ?? Buffer.alloc(0))
          : null,
      }),
    getMultipleAccountsInfo: (addresses: PublicKey[]) =>
      Promise.resolve(
        addresses.map((address) => {
          const found = accounts.find((a) => a.address.equals(address));
          return found === undefined ? null : info(found.data);
        }),
      ),
    getProgramAccounts: () =>
      Promise.resolve(accounts.map((a) => ({ pubkey: a.address, account: info(a.data) }))),
  } as never;
  const provider: AnchorProviderType = new AnchorProvider(
    connection,
    { publicKey: PublicKey.default } as never,
    {},
  );
  return createMeridianProgram(provider);
}

describe("fetchMarkets on real Market account bytes", () => {
  it("decodes a settled YES market with its settle price", async () => {
    const program = programServing([
      {
        address: OWNER,
        data: await marketBytes({
          status: "Settled",
          outcome: "Yes",
          settlePriceScaled: 181_420_000_000_000_000_000n,
        }),
      },
    ]);
    const [row] = await fetchMarkets(program.account.market);
    expect(row).toMatchObject({
      ticker: "NVDA",
      strikeCents: 18_000n,
      settled: true,
      outcome: "Yes",
      settlePriceScaled: 181_420_000_000_000_000_000n,
      pairsOutstanding: 7n,
    });
  });

  it("decodes NO and an open market with no outcome", async () => {
    const program = programServing([
      {
        address: OWNER,
        data: await marketBytes({
          status: "Settled",
          outcome: "No",
          settlePriceScaled: 178_100_000_000_000_000_000n,
        }),
      },
      {
        address: PublicKey.unique(),
        data: await marketBytes({ status: "Open", outcome: "None", settlePriceScaled: 0n }),
      },
    ]);
    const rows = await fetchMarkets(program.account.market);
    expect(rows.map((r) => [r.settled, r.outcome, r.settlePriceScaled])).toEqual([
      [true, "No", 178_100_000_000_000_000_000n],
      [false, "None", 0n],
    ]);
  });
});

describe("fetchConfig on real Config account bytes", () => {
  it("decodes the pause flag and the override delay", async () => {
    const configAddress = findConfigPda().address;
    const admin = key();
    const paused = programServing([
      { address: configAddress, data: configBytes(true, 7_200n, admin) },
    ]);
    expect(await fetchConfig(paused.account.config, configAddress)).toEqual({
      paused: true,
      overrideDelaySecs: 7_200n,
      admin: admin.toBase58(),
    });
    const running = programServing([{ address: configAddress, data: configBytes(false, 3_600n) }]);
    expect(await fetchConfig(running.account.config, configAddress)).toMatchObject({
      paused: false,
      overrideDelaySecs: 3_600n,
    });
  });

  it("propagates a missing Config account", async () => {
    const program = programServing([]);
    await expect(fetchConfig(program.account.config, findConfigPda().address)).rejects.toThrow();
  });
});
