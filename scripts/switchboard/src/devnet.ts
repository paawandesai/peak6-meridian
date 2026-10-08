import { assertCluster, ClusterError, DEVNET_GENESIS_HASH } from "@meridian/client";
import {
  PublicKey,
  type AddressLookupTableAccount,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { CrossbarClient, CrossbarNetwork, type OracleJob } from "@switchboard-xyz/common";
import { LegacyCrossbarClient } from "@switchboard-xyz/common-legacy";
import { AnchorUtils, PullFeed, asV0Tx } from "@switchboard-xyz/on-demand";
import { z } from "zod";

import { SOURCES, TICKERS, type FeedDefinition, type Ticker } from "./feeds";
import { toOracleJobs, type OracleResult, type UpdateSimulator } from "./spike";

/** Genesis hash of Solana devnet (one copy, in `@meridian/client`); other clusters are refused. */
export { DEVNET_GENESIS_HASH };
/** Switchboard On-Demand default devnet queue (same value as the SDK's ON_DEMAND_DEVNET_QUEUE). */
export const DEVNET_QUEUE = new PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7");
export const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";

/**
 * Feed account settings. One oracle sample is enough for the spike on the small devnet queue;
 * staleness matches Config's default `max_staleness_slots` (domain.md).
 */
export const FEED_CONFIG = {
  maxVariance: 1,
  minResponses: 1,
  minSampleSize: 1,
  maxStaleness: 30,
} as const;

/** Throws unless the RPC is Solana devnet (never mainnet, D-012). */
export async function assertDevnet(connection: Pick<Connection, "getGenesisHash">): Promise<void> {
  const genesis = await connection.getGenesisHash();
  try {
    // `cluster: "devnet"` never consults `rpcUrl`, so a localnet genesis is still refused.
    await assertCluster({
      cluster: "devnet",
      rpcUrl: "",
      getGenesisHash: () => Promise.resolve(genesis),
    });
  } catch (error) {
    if (error instanceof ClusterError) {
      throw new Error(`RPC is not Solana devnet (genesis ${genesis}); refusing to run`);
    }
    throw error;
  }
}

/** `SWITCHBOARD_FEEDS_JSON`: `{"AAPL":["<tiingo feed>","<twelvedata feed>"],...}`. */
const feedAccountsSchema = z.partialRecord(
  z.enum(TICKERS),
  z.tuple([z.string(), z.string()]).transform((pair) => pair.map((pk) => new PublicKey(pk))),
);
export type FeedAccounts = Partial<Record<Ticker, PublicKey[]>>;

export function parseFeedAccounts(json: string | undefined): FeedAccounts {
  if (json === undefined || json.trim().length === 0) {
    throw new Error("SWITCHBOARD_FEEDS_JSON is not set; run create-feeds first");
  }
  const parsed = feedAccountsSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(`SWITCHBOARD_FEEDS_JSON: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Replace every secret value in a text (oracle error strings can echo requests). */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

export interface FetchedUpdate {
  readonly ixs: TransactionInstruction[] | undefined;
  readonly luts: AddressLookupTableAccount[];
  readonly oracles: readonly OracleResult[];
}

/** The Switchboard calls the scripts make; `sdkClient` implements it, tests fake it. */
export interface SwitchboardClient {
  /** Publish a feed's jobs to Crossbar so oracles can fetch them by feed hash; returns that hash. */
  storeJobs(queue: PublicKey, jobs: OracleJob[]): Promise<string>;
  /** Create a PullFeed account for the jobs; returns its address. */
  createFeed(def: FeedDefinition, queue: PublicKey): Promise<string>;
  /** The feed hash stored in a PullFeed account (hex). */
  feedHashOf(feed: PublicKey): Promise<string>;
  /** Ask the oracles for a signed update (keys go in `variableOverrides`, never in the job). */
  fetchUpdate(feed: PublicKey, variableOverrides: Record<string, string>): Promise<FetchedUpdate>;
  /** Simulate the update transaction; never sends it. */
  simulate(
    ixs: TransactionInstruction[],
    luts: AddressLookupTableAccount[],
  ): Promise<{ slot: number; error: string | null }>;
}

/** Simulator that fetches a real oracle update for each feed and simulates it on devnet. */
export function liveSimulator(params: {
  readonly client: SwitchboardClient;
  readonly feeds: FeedAccounts;
  readonly variableOverrides: Record<string, string>;
}): UpdateSimulator {
  const secrets = Object.values(params.variableOverrides);
  const run: UpdateSimulator["simulate"] = async (def, feedHash) => {
    const feed = params.feeds[def.ticker]?.[SOURCES.indexOf(def.source)];
    if (feed === undefined) {
      throw new Error(`no feed account for ${def.ticker}/${def.source} in SWITCHBOARD_FEEDS_JSON`);
    }
    const onChainHash = await params.client.feedHashOf(feed);
    if (onChainHash !== feedHash) {
      throw new Error(
        `feed ${feed.toBase58()} has hash ${onChainHash}, definition has ${feedHash}`,
      );
    }
    const update = await params.client.fetchUpdate(feed, params.variableOverrides);
    const oracles = update.oracles.map((o) => ({
      ...o,
      error: o.error === null ? null : redact(o.error, secrets),
    }));
    if (update.ixs === undefined) {
      throw new Error(
        `no oracle signed an update: ${oracles.map((o) => o.error ?? "ok").join("; ")}`,
      );
    }
    const result = await params.client.simulate(update.ixs, update.luts);
    if (result.error !== null) {
      throw new Error(`update simulation failed: ${redact(result.error, secrets)}`);
    }
    return { feed: feed.toBase58(), slot: result.slot, oracles };
  };
  return {
    // SDK/network exceptions can echo the request (and so the keys), same as oracle errors.
    async simulate(def, feedHash) {
      try {
        return await run(def, feedHash);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(redact(message, secrets));
      }
    },
  };
}

export interface CreatedFeed {
  readonly ticker: Ticker;
  readonly source: FeedDefinition["source"];
  readonly feed: string;
  readonly feedHash: string;
}

/** Store each definition's jobs on Crossbar, then create its PullFeed account. */
export async function createFeeds(params: {
  readonly client: SwitchboardClient;
  readonly queue: PublicKey;
  readonly defs: readonly FeedDefinition[];
  readonly feedHash: (def: FeedDefinition) => string;
}): Promise<CreatedFeed[]> {
  const created: CreatedFeed[] = [];
  for (const def of params.defs) {
    const expected = params.feedHash(def);
    const stored = await params.client.storeJobs(params.queue, toOracleJobs(def));
    if (stored.replace(/^0x/, "") !== expected) {
      throw new Error(
        `Crossbar stored ${def.ticker}/${def.source} as ${stored}, expected ${expected}`,
      );
    }
    const feed = await params.client.createFeed(def, params.queue);
    created.push({ ticker: def.ticker, source: def.source, feed, feedHash: expected });
  }
  return created;
}

/** `SWITCHBOARD_FEEDS_JSON` value for created feeds. */
export function feedAccountsJson(created: readonly CreatedFeed[]): string {
  const out: Record<string, string[]> = {};
  for (const ticker of TICKERS) {
    const pair = SOURCES.map((s) => created.find((c) => c.ticker === ticker && c.source === s));
    if (pair.every((c) => c !== undefined)) out[ticker] = pair.map((c) => c?.feed ?? "");
  }
  return JSON.stringify(out);
}

/** SwitchboardClient backed by the On-Demand SDK on devnet. */
export async function sdkClient(
  connection: Connection,
  payer: Keypair,
): Promise<SwitchboardClient> {
  const program = await AnchorUtils.loadProgramFromConnection(connection);
  const crossbar = CrossbarClient.default();
  crossbar.setNetwork(CrossbarNetwork.SolanaDevnet);
  const legacy = new LegacyCrossbarClient(crossbar.crossbarUrl);
  const pullFeed = (feed: PublicKey): PullFeed => {
    const handle = new PullFeed(program, feed);
    handle.setNetwork(CrossbarNetwork.SolanaDevnet);
    return handle;
  };
  return {
    storeJobs: async (queue, jobs) => (await legacy.store(queue.toBase58(), jobs)).feedHash,
    async createFeed(def, queue) {
      const [feed, tx] = await PullFeed.initTx(program, {
        name: def.name,
        queue,
        jobs: toOracleJobs(def),
        payer: payer.publicKey,
        ...FEED_CONFIG,
      });
      tx.sign([payer]);
      const signature = await connection.sendTransaction(tx);
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature, ...latest }, "confirmed");
      return feed.pubkey.toBase58();
    },
    feedHashOf: async (feed) => (await pullFeed(feed).loadConfigs(true)).feedHash.toString("hex"),
    async fetchUpdate(feed, variableOverrides) {
      const [ixs, responses, , luts] = await pullFeed(feed).fetchUpdateIx({
        crossbarClient: crossbar,
        variableOverrides,
        payer: payer.publicKey,
      });
      const oracles = responses.map((r) => ({
        oracle: r.oracle.pubkey.toBase58(),
        value: r.value === null ? null : r.value.toFixed(),
        error: r.error.length > 0 ? r.error : null,
      }));
      return { ixs, luts, oracles };
    },
    async simulate(ixs, luts) {
      const tx = await asV0Tx({ connection, ixs, signers: [payer], lookupTables: luts });
      const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });
      const error = sim.value.err === null ? null : JSON.stringify(sim.value.err);
      return { slot: sim.context.slot, error };
    },
  };
}
