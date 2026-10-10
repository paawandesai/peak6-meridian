/**
 * RedStone oracle integration (M2-16, D-054/D-055 fallback).
 *
 * RedStone is the FALLBACK oracle after Pyth (D-055). Settlement flow:
 * 1. Try Pyth (primary)
 * 2. If Pyth fails, use RedStone with official-close cross-check (<=5 bp)
 *
 * Interface wired after !75 (M2-15) merges with post_redstone_price instruction.
 */

export * from "./types.js";
export * from "./gateway.js";
export * from "./crosscheck.js";

import { PublicKey, type TransactionInstruction } from "@solana/web3.js";

/**
 * Chain interface for RedStone price posting (to be implemented after M2-15).
 *
 * !75 adds:
 * - post_redstone_price instruction
 * - RedstonePrice PDA (["redstone_price", ticker, timestamp])
 * - Payload validation with >=3 pinned signers (lib/oracle-config.ts)
 */
export interface RedstoneChainClient {
  /**
   * Build post_redstone_price instruction for a ticker.
   *
   * @param ticker - MAG7 ticker symbol
   * @param payload - Signed RedStone data package (byte-identical from >=2 gateways)
   * @param timestampMs - Close timestamp in milliseconds
   * @param marketAddress - Market PDA address (for validation)
   * @returns Transaction instruction to post price on-chain
   */
  buildPostPriceIx(
    ticker: string,
    payload: Uint8Array,
    timestampMs: number,
    marketAddress: PublicKey,
  ): Promise<TransactionInstruction>;

  /**
   * Read RedstonePrice PDA to check if already posted.
   * @returns null if not found, or the posted price in cents
   */
  readPostedPrice(ticker: string, timestampMs: number): Promise<number | null>;
}

/**
 * RedStone chain client implementation (post-!75).
 * Builds post_redstone_price instructions and reads RedstonePrice PDAs.
 */
import type { Program } from "@coral-xyz/anchor";
import { type Meridian, symbolBytes } from "@meridian/client";
import { SystemProgram } from "@solana/web3.js";

export class RedstoneChainClientImpl implements RedstoneChainClient {
  constructor(
    private readonly program: Program<Meridian>,
    private readonly config: PublicKey,
  ) {}

  async buildPostPriceIx(
    ticker: string,
    payload: Uint8Array,
    _timestampMs: number,
    marketAddress: PublicKey,
  ): Promise<TransactionInstruction> {
    const symbol = symbolBytes(ticker);

    // Build instruction - Anchor requires explicit accounts despite having seeds in IDL
    // We derive PDAs manually since auto-derivation isn't working
    const [oracleConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle_config")],
      this.program.programId,
    );

    const [redstonePricePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("redstone_price"), Buffer.from(symbol)],
      this.program.programId,
    );

    // Build RPC request directly without using Anchor's type checking
    const ix = await (this.program.methods.postRedstonePrice as any)(
      Array.from(symbol),
      Buffer.from(payload),
    )
      .accountsPartial({
        payer: this.program.provider.publicKey!,
        oracleConfig: oracleConfigPda,
        market: marketAddress,
        redstonePrice: redstonePricePda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    return ix;
  }

  async readPostedPrice(ticker: string, _timestampMs: number): Promise<number | null> {
    const symbol = symbolBytes(ticker);

    const [redstonePricePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("redstone_price"), Buffer.from(symbol)],
      this.program.programId,
    );

    try {
      const account = await this.program.account.redstonePrice.fetch(redstonePricePda);
      // RedStone value is u128 with 8 decimals; convert to cents
      // value / 10^6 = cents (8 decimals → 2 decimals)
      return Number(account.value / 1_000_000n);
    } catch {
      return null; // Account doesn't exist yet
    }
  }
}

/**
 * Placeholder implementation (kept for backwards compatibility).
 * Throws on all calls to ensure it's not used accidentally.
 */
export class RedstoneChainClientPlaceholder implements RedstoneChainClient {
  async buildPostPriceIx(
    _ticker: string,
    _payload: Uint8Array,
    _timestampMs: number,
    _marketAddress: PublicKey,
  ): Promise<TransactionInstruction> {
    throw new Error("RedstoneChainClient: Use RedstoneChainClientImpl instead");
  }

  async readPostedPrice(_ticker: string, _timestampMs: number): Promise<number | null> {
    throw new Error("RedstoneChainClient: Use RedstoneChainClientImpl instead");
  }
}
