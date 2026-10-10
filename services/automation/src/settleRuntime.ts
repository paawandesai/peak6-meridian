/** The pieces of the settlement path that depend on the cluster and the loaded keys. */
import type { Alerter } from "./alerts";
import type { IncidentClient } from "./incidents";
import type { OpenMarket, SettleChain } from "./jobs/settle";
import type { Logger } from "./log";
import type { PrevCloseResult } from "./prevCloses";
import type { PythSettler } from "./pythSettle";
import type { TxExecutor } from "./settleTx";
import type { OracleUpdateAdapter } from "./switchboard";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { IsoDate } from "./calendar";

export type AlerterLike = Alerter;

export interface CommonRuntime {
  readonly chain: SettleChain;
  readonly verifyClose: (ticker: string, date: IsoDate) => Promise<PrevCloseResult>;
  readonly adapter: OracleUpdateAdapter;
  readonly buildSettleIxs: (
    markets: readonly OpenMarket[],
    feeds: readonly [PublicKey, PublicKey],
  ) => Promise<TransactionInstruction[]>;
  readonly executor: TxExecutor;
  /** Present only when Pyth settlement is enabled. */
  readonly pyth?: PythSettler | undefined;
  readonly alerter: Alerter;
  readonly incidents: IncidentClient;
  readonly log: Logger;
}
