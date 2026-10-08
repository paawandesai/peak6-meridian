/**
 * Oracle-update adapters (M2-04): what has to be sent right before `settle_market` so that both
 * feeds of a ticker carry a fresh close.
 *
 * - [`switchboardAdapter`]: Switchboard On-Demand feed-update instructions (devnet and later).
 *   The SDK call is injected (`fetchUpdate`), so tests use recorded instructions and no network.
 * - [`localOracleAdapter`]: the program's `local_oracle_set`, for the local validator only. It is
 *   test-only: the instruction does not exist in a devnet build (AB-22) and the adapter is
 *   selected solely by the localnet branch of `selectAdapter`. It is signed by the Config admin
 *   (`has_one = admin`, pays the `LocalFeed` rent), a keypair injected locally, which is separate
 *   from the `settle_market` payer and from the automation key.
 */
import { type Program } from "@coral-xyz/anchor";
import { BN, type Meridian, symbolBytes } from "@meridian/client";
import {
  type AddressLookupTableAccount,
  type Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { ClusterName } from "./cluster";
import { describeError } from "./log";

/** Oracle values carry 18 fractional digits; cents × 10^16 (matches `STRIKE_CENTS_TO_SCALED`). */
export const CENTS_TO_SCALED = 10n ** 16n;

export interface FeedUpdate {
  readonly ixs: readonly TransactionInstruction[];
  readonly luts: readonly AddressLookupTableAccount[];
}

export interface UpdateRequest {
  readonly ticker: string;
  /** The verified close both sources agree on, in cents (the local oracle publishes this). */
  readonly closeCents: number;
  /** The Config-pinned feeds of the ticker: index 0 = Tiingo, index 1 = Twelve Data. */
  readonly feeds: readonly [PublicKey, PublicKey];
  readonly slot: number;
}

export interface BuiltUpdate extends FeedUpdate {
  /** Signers beyond the settlement payer (the local admin); empty for Switchboard. */
  readonly signers: readonly Keypair[];
}

export interface OracleUpdateAdapter {
  readonly kind: "switchboard" | "local";
  build(request: UpdateRequest): Promise<BuiltUpdate>;
}

/** Fetches Switchboard's signed update for one feed (production: the SDK; tests: a fixture). */
export type FetchFeedUpdate = (feed: PublicKey) => Promise<FeedUpdate>;

/** One update per Config-pinned feed, in feed order, lookup tables de-duplicated. */
export function switchboardAdapter(fetchUpdate: FetchFeedUpdate): OracleUpdateAdapter {
  return {
    kind: "switchboard",
    async build(request) {
      const ixs: TransactionInstruction[] = [];
      const luts = new Map<string, AddressLookupTableAccount>();
      for (const feed of request.feeds) {
        const update = await fetchUpdate(feed);
        ixs.push(...update.ixs);
        for (const lut of update.luts) {
          luts.set(lut.key.toBase58(), lut);
        }
      }
      return { ixs, luts: [...luts.values()], signers: [] };
    },
  };
}

/** `local_oracle_set` for both source slots of the ticker, signed by the injected admin. */
export function localOracleAdapter(params: {
  readonly program: Program<Meridian>;
  readonly config: PublicKey;
  readonly admin: Keypair;
}): OracleUpdateAdapter {
  return {
    kind: "local",
    async build(request) {
      const ixs: TransactionInstruction[] = [];
      for (const sourceSlot of [0, 1]) {
        const feed = request.feeds[sourceSlot];
        if (feed === undefined) {
          throw new Error(`no feed for source slot ${String(sourceSlot)}`);
        }
        ixs.push(
          await params.program.methods
            .localOracleSet(
              Array.from(symbolBytes(request.ticker)),
              sourceSlot,
              new BN((BigInt(request.closeCents) * CENTS_TO_SCALED).toString()),
              new BN(request.slot),
            )
            .accountsStrict({
              config: params.config,
              localFeed: feed,
              admin: params.admin.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        );
      }
      return { ixs, luts: [], signers: [params.admin] };
    },
  };
}

/**
 * Picks the adapter for the cluster. The local adapter is reachable only when the verified
 * cluster is `localnet` and an admin keypair was supplied; on devnet only Switchboard is used.
 */
export function selectAdapter(params: {
  readonly cluster: ClusterName;
  readonly switchboard: () => OracleUpdateAdapter;
  readonly local: () => OracleUpdateAdapter;
}): OracleUpdateAdapter {
  return params.cluster === "localnet" ? params.local() : params.switchboard();
}

// ---- the on-demand SDK, behind an interface ---------------------------------------------------

/** What `sdkClient` (scripts/switchboard, M1-09) offers; a fake in tests. */
export interface UpdateClient {
  fetchUpdate(
    feed: PublicKey,
    variableOverrides: Record<string, string>,
  ): Promise<{
    readonly ixs: TransactionInstruction[] | undefined;
    readonly luts: AddressLookupTableAccount[];
    readonly oracles: readonly {
      readonly oracle: string;
      readonly value: string | null;
      readonly error: string | null;
    }[];
  }>;
}

/** `text` with every secret replaced, so API keys echoed by oracles or the SDK never surface. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

/**
 * The real feed-update fetcher: asks the oracles (through `client`) for a signed update of one
 * feed. An update that no oracle signed is an error naming the oracles' reasons, never an empty
 * instruction list that would send `settle_market` into a stale feed. The API keys travel as
 * `variableOverrides` and are redacted from every error raised here, URLs are stripped too.
 */
export function sdkFeedUpdater(params: {
  readonly client: () => Promise<UpdateClient>;
  readonly overrides: Readonly<Record<string, string>>;
}): FetchFeedUpdate {
  const secrets = Object.values(params.overrides);
  return async (feed) => {
    try {
      const update = await (await params.client()).fetchUpdate(feed, { ...params.overrides });
      if (update.ixs === undefined || update.ixs.length === 0) {
        const reasons = update.oracles.map((o) => o.error ?? "no value").join("; ");
        throw new Error(
          `no oracle signed an update for feed ${feed.toBase58()}: ${reasons.length > 0 ? reasons : "no oracle responded"}`,
        );
      }
      return { ixs: update.ixs, luts: update.luts };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      throw new Error(describeError(new Error(redactSecrets(raw, secrets))));
    }
  };
}
