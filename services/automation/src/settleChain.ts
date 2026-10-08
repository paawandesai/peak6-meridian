/** Read-only view of the chain for the settlement job: open markets, Config feeds, payer balance. */
import { type Program } from "@coral-xyz/anchor";
import { type Meridian, symbolFromBytes } from "@meridian/client";
import { type PublicKey } from "@solana/web3.js";

import type { OpenMarket, PinnedFeeds, SettleChain } from "./jobs/settle";

export function programSettleChain(
  program: Program<Meridian>,
  config: PublicKey,
  payer: PublicKey,
): SettleChain {
  return {
    async openMarkets() {
      const all = await program.account.market.all();
      const open: OpenMarket[] = [];
      for (const { publicKey, account } of all) {
        if ("open" in account.status) {
          open.push({
            address: publicKey,
            ticker: symbolFromBytes(account.ticker),
            tradingDate: account.tradingDate,
            closeTs: Number(account.closeTs.toString()),
            strikeCents: BigInt(account.strikeCents.toString()),
          });
        }
      }
      return open;
    },
    async pinnedFeeds(): Promise<PinnedFeeds> {
      const account = await program.account.config.fetch(config);
      const feeds: Record<string, readonly [PublicKey, PublicKey]> = {};
      for (const ticker of account.tickers) {
        const symbol = symbolFromBytes(ticker.symbol);
        const [tiingo, twelveData] = ticker.feeds;
        if (symbol !== "" && tiingo !== undefined && twelveData !== undefined) {
          feeds[symbol] = [tiingo, twelveData];
        }
      }
      return { feeds, maxStalenessSlots: Number(account.maxStalenessSlots.toString()) };
    },
    balanceLamports: () => program.provider.connection.getBalance(payer, "confirmed"),
  };
}
