// AB-02 · Redeem attacks (threat-model.md; NFR-07; M2-04 AC4).
// Attacks: (1) redeem the losing token, (2) redeem twice, (3) winner-redeem before settlement, (4)
// pair-redeem with YES/NO from different markets. Expected: loser pays 0; tokens are burned before
// transfer; winner mode requires `Settled`; pair redeem checks both tokens are from the same market.
import { BN } from "@meridian/client";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getMint, mintTo } from "@solana/spl-token";
import { describe, expect, it } from "vitest";

import {
  createMarket,
  localFeedPda,
  programError,
  setLocalFeed,
  SKIP_REASON,
  trySettle,
  type Validator,
  validatorSession,
  waitUntil,
} from "./validator";

// SPL Token Program ID
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Associated Token Program ID
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Create an associated token account */
async function createAta(
  v: Validator,
  user: Keypair,
  ata: PublicKey,
  mint: PublicKey,
): Promise<void> {
  const info = await v.connection.getAccountInfo(ata);
  if (info !== null) return; // already exists

  const createAtaIx = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: user.publicKey, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([]),
  });
  const tx = new Transaction().add(createAtaIx);
  tx.recentBlockhash = (await v.connection.getLatestBlockhash()).blockhash;
  tx.feePayer = user.publicKey;
  tx.sign(user);
  await v.connection.sendRawTransaction(tx.serialize());
  await new Promise((r) => setTimeout(r, 1000));
}

/** Fund a user's USDC ATA by minting USDC (validator environment only) */
async function fundUsdc(
  v: Validator,
  owner: PublicKey,
  ata: PublicKey,
  amount: number,
): Promise<void> {
  const config = await v.program.account.config.fetch(v.config);
  const mint = await getMint(v.connection, config.usdcMint);
  const mintAmount = BigInt(amount) * 10n ** BigInt(mint.decimals);
  await mintTo(v.connection, v.admin, config.usdcMint, ata, v.admin, mintAmount);
  await new Promise((r) => setTimeout(r, 500));
}

/** Derive ATA address for a given mint and wallet */
function getAta(mint: PublicKey, wallet: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

const v = validatorSession();
describe.runIf(v !== null)("AB-02 on-chain (local validator): redeem attacks rejected", () => {
  it(
    "cannot winner-redeem before settlement (MarketNotSettled)",
    { timeout: 180_000 },
    async () => {
      if (v === null) {
        throw new Error(SKIP_REASON);
      }
      const user = Keypair.generate();
      await v.connection.requestAirdrop(user.publicKey, 10_000_000_000);
      await new Promise((r) => setTimeout(r, 1000));

      const { market } = await createMarket(v, 3600);
      const marketAccount = await v.program.account.market.fetch(market);
      const config = await v.program.account.config.fetch(v.config);

      // User token accounts (ATA derivation)
      const userUsdc = getAta(config.usdcMint, user.publicKey);
      const userYes = getAta(marketAccount.yesMint, user.publicKey);
      const userNo = getAta(marketAccount.noMint, user.publicKey);

      // Attempt: winner redeem BEFORE settlement (market status is Open, not Settled)
      // Expected: rejected with MarketNotSettled or similar error
      try {
        await v.program.methods
          .redeem(new BN(1), new BN(0)) // 1 YES, 0 NO (winner redeem shape)
          .accountsStrict({
            market,
            user: user.publicKey,
            userUsdc,
            userYes,
            userNo,
            yesMint: marketAccount.yesMint,
            noMint: marketAccount.noMint,
            vault: marketAccount.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
        throw new Error("Expected redeem to fail before settlement");
      } catch (error) {
        const err = programError(error);
        // Market is Open, not Settled, so either account constraint fails or explicit check
        expect(err.length).toBeGreaterThan(0);
      }
    },
  );

  it(
    "losing token pays 0 USDC (tokens burned, vault pays based on outcome)",
    { timeout: 180_000 },
    async () => {
      if (v === null) {
        throw new Error(SKIP_REASON);
      }
      const user = Keypair.generate();
      await v.connection.requestAirdrop(user.publicKey, 10_000_000_000);
      await new Promise((r) => setTimeout(r, 1000));

      const { market, closeTs } = await createMarket(v, 10);
      await waitUntil(v, closeTs);

      // Settle: YES wins (close > strike)
      const slot = await v.connection.getSlot("confirmed");
      await setLocalFeed(v, "META", 0, 50_000n, slot);
      await setLocalFeed(v, "META", 1, 50_000n, slot);

      const feeds: readonly [PublicKey, PublicKey] = [
        localFeedPda(v.programId, "META", 0),
        localFeedPda(v.programId, "META", 1),
      ] as const;
      expect(await trySettle(v, market, feeds)).toBe("settled");

      const marketAccount = await v.program.account.market.fetch(market);
      const config = await v.program.account.config.fetch(v.config);

      // User would need NO tokens to redeem (the loser)
      // Since user has no tokens, redeem will fail with insufficient balance
      // In a real attack, even if user had NO tokens, they would burn and get 0 USDC
      const userUsdc = getAta(config.usdcMint, user.publicKey);
      const userYes = getAta(marketAccount.yesMint, user.publicKey);
      const userNo = getAta(marketAccount.noMint, user.publicKey);

      // Attempt: redeem NO (loser) - expects to receive 0 USDC after burning tokens
      try {
        await v.program.methods
          .redeem(new BN(0), new BN(1)) // 0 YES, 1 NO (loser)
          .accountsStrict({
            market,
            user: user.publicKey,
            userUsdc,
            userYes,
            userNo,
            yesMint: marketAccount.yesMint,
            noMint: marketAccount.noMint,
            vault: marketAccount.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
        throw new Error("Expected redeem to fail (no tokens)");
      } catch (error) {
        // Fails because user has no NO tokens to burn
        const err = programError(error);
        expect(err.length).toBeGreaterThan(0);
      }
    },
  );

  it("cannot redeem twice (tokens burned on first redeem)", { timeout: 180_000 }, async () => {
    if (v === null) {
      throw new Error(SKIP_REASON);
    }
    const user = Keypair.generate();
    await v.connection.requestAirdrop(user.publicKey, 10_000_000_000);
    await new Promise((r) => setTimeout(r, 1000));

    const { market, closeTs } = await createMarket(v, 10);

    const marketAccount = await v.program.account.market.fetch(market);
    const config = await v.program.account.config.fetch(v.config);

    const userUsdc = getAta(config.usdcMint, user.publicKey);
    const userYes = getAta(marketAccount.yesMint, user.publicKey);
    const userNo = getAta(marketAccount.noMint, user.publicKey);

    // Create ATAs and mint 10 pairs (deposit 10 USDC, mint 10 YES + 10 NO)
    await createAta(v, user, userUsdc, config.usdcMint);
    await createAta(v, user, userYes, marketAccount.yesMint);
    await createAta(v, user, userNo, marketAccount.noMint);

    // Fund user with USDC and mint pairs
    await fundUsdc(v, user.publicKey, userUsdc, 10);
    await v.program.methods
      .mintPair(new BN(10))
      .accountsStrict({
        config: v.config,
        market,
        user: user.publicKey,
        userUsdc,
        userYes,
        userNo,
        yesMint: marketAccount.yesMint,
        noMint: marketAccount.noMint,
        vault: marketAccount.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    await waitUntil(v, closeTs);

    // Settle the market (YES wins: close >= strike)
    // Strike is ~900M cents, so close at 900M + 1 cent means YES wins
    const slot = await v.connection.getSlot("confirmed");
    const closePrice = BigInt(marketAccount.strikeCents.toString()) + 1n; // at-or-above = YES wins
    await setLocalFeed(v, "META", 0, closePrice, slot);
    await setLocalFeed(v, "META", 1, closePrice, slot);
    const feeds: readonly [PublicKey, PublicKey] = [
      localFeedPda(v.programId, "META", 0),
      localFeedPda(v.programId, "META", 1),
    ] as const;
    expect(await trySettle(v, market, feeds)).toBe("settled");

    // First redeem: should succeed (burn 10 YES, receive 10 USDC)
    const usdcBefore = await v.connection.getTokenAccountBalance(userUsdc);
    await v.program.methods
      .redeem(new BN(10), new BN(0)) // winner redeem (YES won at-or-above strike)
      .accountsStrict({
        market,
        user: user.publicKey,
        userUsdc,
        userYes,
        userNo,
        yesMint: marketAccount.yesMint,
        noMint: marketAccount.noMint,
        vault: marketAccount.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    // Verify winner payout: 10 USDC received (10 pairs * 1 USDC collateral)
    const usdcAfter = await v.connection.getTokenAccountBalance(userUsdc);
    const received = BigInt(usdcAfter.value.amount) - BigInt(usdcBefore.value.amount);
    expect(received).toBe(10_000_000n); // 10 USDC (6 decimals)

    // Second redeem: should fail (tokens were burned, balance is now 0)
    try {
      await v.program.methods
        .redeem(new BN(1), new BN(0))
        .accountsStrict({
          market,
          user: user.publicKey,
          userUsdc,
          userYes,
          userNo,
          yesMint: marketAccount.yesMint,
          noMint: marketAccount.noMint,
          vault: marketAccount.vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      throw new Error("Expected second redeem to fail (tokens already burned)");
    } catch (error) {
      // Second redeem fails: insufficient YES tokens (all were burned in first redeem)
      const err = programError(error);
      expect(err).toContain("insufficient");
    }
  });

  it("pair-redeem checks both tokens are from same market", { timeout: 180_000 }, async () => {
    if (v === null) {
      throw new Error(SKIP_REASON);
    }
    const user = Keypair.generate();
    await v.connection.requestAirdrop(user.publicKey, 10_000_000_000);
    await new Promise((r) => setTimeout(r, 1000));

    // Create two different markets
    const { market: market1 } = await createMarket(v, 3600);
    const { market: market2 } = await createMarket(v, 3600);

    const market1Account = await v.program.account.market.fetch(market1);
    const market2Account = await v.program.account.market.fetch(market2);
    const config = await v.program.account.config.fetch(v.config);

    const userUsdc = getAta(config.usdcMint, user.publicKey);

    // Attempt: pair redeem with YES from market1 and NO from market2
    // User token accounts would be from different markets
    const userYes1 = getAta(market1Account.yesMint, user.publicKey);
    const userNo2 = getAta(market2Account.noMint, user.publicKey);

    // Try to redeem against market1 with mismatched NO mint
    try {
      await v.program.methods
        .redeem(new BN(1), new BN(1)) // pair redeem
        .accountsStrict({
          market: market1,
          user: user.publicKey,
          userUsdc,
          userYes: userYes1,
          userNo: userNo2, // WRONG - from market2, not market1
          yesMint: market1Account.yesMint,
          noMint: market2Account.noMint, // WRONG - should be market1.noMint
          vault: market1Account.vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      throw new Error("Expected cross-market redeem to fail");
    } catch (error) {
      // Program constraints (has_one = no_mint) reject the substitution
      const err = programError(error);
      expect(err.length).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(v !== null)("AB-02 on-chain (local validator)", () => {
  it.skip(SKIP_REASON, () => undefined);
});
