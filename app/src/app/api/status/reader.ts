/**
 * Real StatusChainReader implementation using status-chain (P1-6).
 * Wires /api/status to the on-chain data layer after !122.
 */
import { PublicKey } from "@solana/web3.js";
import { loadStatusData } from "@/app/status/status-chain";
import { createReader } from "@/lib/chain";
import { loadPublicConfig } from "@/lib/config";
import { sharedConnection } from "@/lib/rpc";
import type { MarketInvariant } from "./route";
import type { StatusChainReader } from "./route";

const USDC_BASE_PER_CONTRACT = 1_000_000n; // 1 USDC = 1M base units

/**
 * Real implementation of StatusChainReader using loadStatusData from status-chain.ts.
 */
class RealStatusChainReader implements StatusChainReader {
  private programId: PublicKey;

  constructor(programId: string) {
    this.programId = new PublicKey(programId);
  }

  async fetchMarketInvariants(tradingDate: number): Promise<MarketInvariant[]> {
    const config = loadPublicConfig();
    const reader = createReader(config);
    const connection = sharedConnection(config.rpcUrl);

    // Load all markets and filter to this trading date
    const allMarkets = await reader.listMarkets();
    const dateMarkets = allMarkets.filter((m) => m.tradingDate === tradingDate);

    if (dateMarkets.length === 0) {
      return [];
    }

    // Load status data (vaults + facts)
    const statusData = await loadStatusData(connection, dateMarkets, this.programId);

    // Build invariant rows
    return statusData.markets.map((market) => {
      const vaultBase = statusData.vaults.get(market.address) ?? null;
      const facts = statusData.facts.get(market.address);
      const pairsOutstanding = BigInt(market.pairsOutstanding);
      const expectedVaultBase = pairsOutstanding * USDC_BASE_PER_CONTRACT;
      const invariantPass = vaultBase !== null && vaultBase === expectedVaultBase;

      return {
        address: market.address,
        ticker: market.ticker,
        strikeCents: Number(market.strikeCents),
        vaultBase: vaultBase?.toString() ?? "0",
        pairsOutstanding: pairsOutstanding.toString(),
        expectedVaultBase: expectedVaultBase.toString(),
        invariantPass,
        closeTs: Number(market.closeTs),
        settledAt: facts?.settledAt ?? 0,
        oracleAsOf: Number(facts?.oracleSlot ?? 0n),
      };
    });
  }

  async getActiveDate(): Promise<number> {
    const config = loadPublicConfig();
    const reader = createReader(config);
    const allMarkets = await reader.listMarkets();

    if (allMarkets.length === 0) {
      // No markets, return today's date in ET
      const now = new Date();
      const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      return (
        etDate.getFullYear() * 10000 + (etDate.getMonth() + 1) * 100 + etDate.getDate()
      );
    }

    // Return the most recent trading date
    const dates = [...new Set(allMarkets.map((m) => m.tradingDate))].sort((a, b) => b - a);
    return dates[0] ?? 0;
  }
}

/**
 * Install the real StatusChainReader on globalThis (called at module load in production).
 */
export function installStatusChainReader(): void {
  const programId = process.env.NEXT_PUBLIC_PROGRAM_ID;

  if (!programId) {
    console.warn("Status chain reader not installed: missing PROGRAM_ID");
    return;
  }

  (globalThis as { statusChainReader?: StatusChainReader }).statusChainReader =
    new RealStatusChainReader(programId);
}

// Auto-install in production (not in tests)
if (typeof window === "undefined" && process.env.NODE_ENV !== "test") {
  installStatusChainReader();
}
