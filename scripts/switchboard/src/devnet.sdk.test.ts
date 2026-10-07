// sdkClient against mocked Switchboard SDK modules: checks the calls it makes, never the network.
import { Keypair, type Connection } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  setNetwork: vi.fn(),
  store: vi.fn(),
  initTx: vi.fn(),
  loadConfigs: vi.fn(),
  fetchUpdateIx: vi.fn(),
  feedSetNetwork: vi.fn(),
  asV0Tx: vi.fn(),
  loadProgram: vi.fn(),
}));

vi.mock("@switchboard-xyz/common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@switchboard-xyz/common")>()),
  CrossbarClient: {
    default: () => ({ crossbarUrl: "https://crossbar.test", setNetwork: sdk.setNetwork }),
  },
}));
vi.mock("@switchboard-xyz/common-legacy", () => ({
  LegacyCrossbarClient: class {
    constructor(readonly url: string) {}
    store = sdk.store;
  },
}));
vi.mock("@switchboard-xyz/on-demand", () => ({
  AnchorUtils: { loadProgramFromConnection: sdk.loadProgram },
  asV0Tx: sdk.asV0Tx,
  PullFeed: class {
    static initTx = sdk.initTx;
    constructor(
      readonly program: unknown,
      readonly pubkey: unknown,
    ) {}
    setNetwork = sdk.feedSetNetwork;
    loadConfigs = sdk.loadConfigs;
    fetchUpdateIx = sdk.fetchUpdateIx;
  },
}));

const { DEFAULT_FEEDS_DIR } = await import("./cli");
const { DEVNET_QUEUE, FEED_CONFIG, sdkClient } = await import("./devnet");
const { loadFeedDefinitions } = await import("./feeds");

const def = loadFeedDefinitions(DEFAULT_FEEDS_DIR)[0];
if (def === undefined) throw new Error("no definitions");
const payer = Keypair.generate();
const feed = Keypair.generate().publicKey;

const connection = {
  sendTransaction: vi.fn(() => Promise.resolve("sig")),
  getLatestBlockhash: vi.fn(() => Promise.resolve({ blockhash: "bh", lastValidBlockHeight: 1 })),
  confirmTransaction: vi.fn(() => Promise.resolve({ value: { err: null } })),
  simulateTransaction: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  sdk.loadProgram.mockResolvedValue({ programId: "sb" });
});

async function client() {
  return sdkClient(connection as unknown as Connection, payer);
}

describe("sdkClient", () => {
  it("uses the devnet Crossbar network", async () => {
    await client();
    expect(sdk.setNetwork).toHaveBeenCalledWith("devnet");
  });

  it("storeJobs posts the queue and jobs to Crossbar and returns its feed hash", async () => {
    sdk.store.mockResolvedValue({ feedHash: "0xabc", cid: "c", queueHex: "q" });
    const jobs = [{ tasks: [] }] as never;
    await expect((await client()).storeJobs(DEVNET_QUEUE, jobs)).resolves.toBe("0xabc");
    expect(sdk.store).toHaveBeenCalledWith(DEVNET_QUEUE.toBase58(), jobs);
  });

  it("createFeed initialises a PullFeed with the definition's jobs, signs and confirms", async () => {
    const tx = { sign: vi.fn() };
    sdk.initTx.mockResolvedValue([{ pubkey: feed }, tx]);
    await expect((await client()).createFeed(def, DEVNET_QUEUE)).resolves.toBe(feed.toBase58());
    const [, params] = sdk.initTx.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(params).toMatchObject({ name: def.name, queue: DEVNET_QUEUE, ...FEED_CONFIG });
    expect(tx.sign).toHaveBeenCalledWith([payer]);
    expect(connection.confirmTransaction).toHaveBeenCalledWith(
      { signature: "sig", blockhash: "bh", lastValidBlockHeight: 1 },
      "confirmed",
    );
  });

  it("feedHashOf reads the on-chain config", async () => {
    sdk.loadConfigs.mockResolvedValue({ feedHash: Buffer.from("ab".repeat(32), "hex") });
    await expect((await client()).feedHashOf(feed)).resolves.toBe("ab".repeat(32));
    expect(sdk.loadConfigs).toHaveBeenCalledWith(true);
    expect(sdk.feedSetNetwork).toHaveBeenCalledWith("devnet");
  });

  it("fetchUpdate passes the keys as variableOverrides and maps oracle responses", async () => {
    const oracle = Keypair.generate().publicKey;
    sdk.fetchUpdateIx.mockResolvedValue([
      ["ix"],
      [
        { oracle: { pubkey: oracle }, value: { toFixed: () => "254.43" }, error: "" },
        { oracle: { pubkey: oracle }, value: null, error: "HTTP 401" },
      ],
      1,
      ["lut"],
      [],
    ]);
    const overrides = { TIINGO_API_KEY: "k" };
    const update = await (await client()).fetchUpdate(feed, overrides);
    expect(sdk.fetchUpdateIx.mock.calls[0]?.[0]).toMatchObject({ variableOverrides: overrides });
    expect(update).toEqual({
      ixs: ["ix"],
      luts: ["lut"],
      oracles: [
        { oracle: oracle.toBase58(), value: "254.43", error: null },
        { oracle: oracle.toBase58(), value: null, error: "HTTP 401" },
      ],
    });
  });

  it("simulate builds a v0 transaction and only simulates it", async () => {
    sdk.asV0Tx.mockResolvedValue("tx");
    connection.simulateTransaction.mockResolvedValueOnce({
      context: { slot: 5 },
      value: { err: null },
    });
    connection.simulateTransaction.mockResolvedValueOnce({
      context: { slot: 6 },
      value: { err: { InstructionError: [0, "Custom"] } },
    });
    const c = await client();
    await expect(c.simulate([], [])).resolves.toEqual({ slot: 5, error: null });
    await expect(c.simulate([], [])).resolves.toEqual({
      slot: 6,
      error: '{"InstructionError":[0,"Custom"]}',
    });
    expect(connection.sendTransaction).not.toHaveBeenCalled();
  });
});
