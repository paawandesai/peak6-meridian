/**
 * A fake world for the settlement job: in-memory markets and Config feeds, an executor that
 * records every transaction it is asked to send (and "settles" the markets named by the
 * `settle_market` instructions it sees), and fixed-clock helpers. No network, no validator.
 */
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { createMeridianProgram, findConfigPda, type Meridian } from "@meridian/client";
import type { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  SETTLE_DELAY_SECS,
  JOB_OPTIONS,
  SettleMemory,
  type OpenMarket,
  type PinnedFeeds,
  type SettleChain,
  type SettleDeps,
} from "../jobs/settle";
import { RunState } from "../state";
import { buildSettleInstructions, type PlannedTx, type TxExecutor } from "../settleTx";
import { type OracleUpdateAdapter, switchboardAdapter } from "../switchboard";
import { fetchPrevClose, type HttpGet, type PrevCloseResult } from "../prevCloses";
import { fakeSourcesHttp } from "./fakeHttp";
import { FakeClock, RecordingAlerter, recordingLogger } from "./harness";
import { loadUpdateFixture } from "./updateFixture";

export interface SentTx {
  readonly tx: PlannedTx;
  readonly slot: number;
  readonly signers: readonly string[];
}

/** An executor that records sends, advances a slot counter and settles the markets it sees. */
export class FakeExecutor implements TxExecutor {
  readonly sent: SentTx[] = [];
  slot = 1_000;
  /** Slots that pass during each send (a function of the send index). */
  advancePerSend: (index: number) => number = () => 1;
  /** Makes a send fail (returns the error to throw, or null). */
  failWith: (index: number) => Error | null = () => null;
  /** Called with the market addresses settled by a successful send. */
  onSettle: (markets: PublicKey[]) => void = () => undefined;

  constructor(private readonly programId: PublicKey) {}

  currentSlot = (): Promise<number> => Promise.resolve(this.slot);

  send = (
    tx: PlannedTx,
    extraSigners: readonly Keypair[],
  ): Promise<{ signature: string; slot: number }> => {
    const index = this.sent.length;
    const error = this.failWith(index);
    if (error !== null) {
      return Promise.reject(error);
    }
    this.slot += this.advancePerSend(index);
    this.sent.push({
      tx,
      slot: this.slot,
      signers: extraSigners.map((s) => s.publicKey.toBase58()),
    });
    this.onSettle(
      tx.instructions
        .filter((ix) => ix.programId.equals(this.programId))
        .map((ix) => ix.keys[1]?.pubkey)
        .filter((key): key is PublicKey => key !== undefined),
    );
    return Promise.resolve({ signature: `sig-${String(index)}`, slot: this.slot });
  };

  get settleSends(): SentTx[] {
    return this.sent.filter((s) => s.tx.role !== "update");
  }
}

export interface WorldOptions {
  /** Markets as (ticker, strike dollars, tradingDate); all share `closeTs`. */
  readonly markets: readonly { ticker: string; strike: number; tradingDate?: number }[];
  readonly closeTs: number;
  /** Start of the fake clock. */
  readonly start: Date;
  /** Closes served by the fake data sources, by ticker; defaults to META 68,000. */
  readonly closes?: Record<string, number>;
  /** The ET date of the bar the fake sources serve. */
  readonly sourceDate?: string;
  readonly balanceLamports?: number;
  readonly delaySecs?: number;
}

export const WORLD_TRADING_DATE = 20_261_006;

export class SettleWorld {
  readonly payer = Keypair.generate();
  readonly program: Program<Meridian>;
  readonly config: PublicKey;
  readonly clock: FakeClock;
  readonly alerter = new RecordingAlerter();
  readonly logger = recordingLogger();
  readonly state = new RunState();
  readonly executor: FakeExecutor;
  readonly incidents: { kind: string; tickers: readonly string[] }[] = [];
  readonly update = loadUpdateFixture();
  readonly memory = new SettleMemory();
  open: OpenMarket[];
  closes: Record<string, number>;
  sourceDate: string;
  /** Twelve Data's latest bar date, when it differs from `sourceDate` (a stale source). */
  twelveDataDate: string | undefined;
  balance: number;
  verifyCalls: { ticker: string; date: string }[] = [];
  /** Overrides the data sources' answer, e.g. to simulate a wrong date. */
  verifyOverride: ((ticker: string, date: string) => PrevCloseResult | null) | null = null;
  /** Replaces the fake data-API HTTP (e.g. to answer 429); every request is still recorded. */
  httpOverride: HttpGet | null = null;
  /** Every data-API request made through `verifyClose`, across runs. */
  readonly httpCalls: string[] = [];
  pinned: PinnedFeeds;
  private readonly delaySecs: number;

  constructor(options: WorldOptions) {
    this.program = createMeridianProgram(
      new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(this.payer), {}),
    );
    this.config = findConfigPda(this.program.programId).address;
    this.clock = new FakeClock(options.start);
    this.executor = new FakeExecutor(this.program.programId);
    this.closes = options.closes ?? { META: 68_000, AAPL: 23_000 };
    this.sourceDate = options.sourceDate ?? "2026-10-06";
    this.twelveDataDate = undefined;
    this.balance = options.balanceLamports ?? 1_000_000_000;
    this.delaySecs = options.delaySecs ?? SETTLE_DELAY_SECS;
    this.open = options.markets.map((m) => ({
      address: Keypair.generate().publicKey,
      ticker: m.ticker,
      tradingDate: m.tradingDate ?? WORLD_TRADING_DATE,
      closeTs: options.closeTs,
      strikeCents: BigInt(m.strike) * 100n,
    }));
    this.pinned = {
      feeds: { META: this.update.feeds, AAPL: this.update.feeds },
      maxStalenessSlots: 30,
    };
    this.executor.onSettle = (settled) => {
      const keys = new Set(settled.map((k) => k.toBase58()));
      this.open = this.open.filter((m) => !keys.has(m.address.toBase58()));
    };
  }

  get chain(): SettleChain {
    return {
      openMarkets: () => Promise.resolve([...this.open]),
      pinnedFeeds: () => Promise.resolve(this.pinned),
      balanceLamports: () => Promise.resolve(this.balance),
    };
  }

  adapter(): OracleUpdateAdapter {
    return switchboardAdapter(this.update.fetchUpdate);
  }

  deps(overrides: Partial<SettleDeps> = {}): SettleDeps {
    const http = (): HttpGet => {
      const inner =
        this.httpOverride ??
        fakeSourcesHttp({
          closes: this.closes,
          date: this.sourceDate,
          ...(this.twelveDataDate === undefined ? {} : { twelveDataDate: this.twelveDataDate }),
        });
      return (url, init) => {
        this.httpCalls.push(url);
        return inner(url, init);
      };
    };
    return {
      now: this.clock.now,
      chain: this.chain,
      verifyClose: (ticker, date) => {
        this.verifyCalls.push({ ticker, date });
        const forced = this.verifyOverride?.(ticker, date);
        if (forced !== null && forced !== undefined) {
          return Promise.resolve(forced);
        }
        return fetchPrevClose(
          { http: http(), tiingoApiKey: "k", twelveDataApiKey: "k" },
          ticker,
          date,
        );
      },
      adapter: this.adapter(),
      buildSettleIxs: (markets, feeds) =>
        buildSettleInstructions({
          program: this.program,
          config: this.config,
          payer: this.payer.publicKey,
          markets: markets.map((m) => m.address),
          feeds,
        }),
      payer: this.payer.publicKey,
      executor: this.executor,
      alerter: this.alerter,
      incidents: {
        post: (incident) => {
          this.incidents.push({ kind: incident.kind, tickers: incident.tickers });
          return Promise.resolve(true);
        },
      },
      state: this.state,
      log: this.logger.log,
      options: { ...JOB_OPTIONS, delaySecs: this.delaySecs },
      memory: this.memory,
      ...overrides,
    };
  }
}
