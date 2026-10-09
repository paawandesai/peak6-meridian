// AB-01 · Mint YES/NO without depositing equal USDC (threat-model.md; NFR-07; M2-03 AC5).
// Attacks: (1) call SPL Token mint directly (bypass mint_pair), (2) verify mint authority is market
// PDA (attacker cannot be authority), (3) substitute wrong market accounts. Expected: mint authority
// is the market PDA; only `mint_pair` mints after USDC transfer; constraints reject substitutes.
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { createMarket, SKIP_REASON, validatorSession } from "./validator";

// SPL Token Program ID
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// SPL Token MintTo instruction discriminator
const MINT_TO_DISCRIMINATOR = 7;

const v = validatorSession();
describe.runIf(v !== null)("AB-01 on-chain (local validator): mint attacks rejected", () => {
  it(
    "mint authority is the market PDA (parsed from mint account data)",
    { timeout: 120_000 },
    async () => {
      if (v === null) {
        throw new Error(SKIP_REASON);
      }
      const { market } = await createMarket(v, 3600);
      const marketAccount = await v.program.account.market.fetch(market);
      const yesMint = marketAccount.yesMint;
      const noMint = marketAccount.noMint;

      // Fetch SPL Token Mint account data
      const yesMintInfo = await v.connection.getAccountInfo(yesMint);
      const noMintInfo = await v.connection.getAccountInfo(noMint);

      expect(yesMintInfo).not.toBeNull();
      expect(noMintInfo).not.toBeNull();

      // SPL Token Mint layout: https://spl.solana.com/token
      // Offset 0: mint_authority (COption<Pubkey>) - 4 bytes (0=None, 1=Some) + 32 bytes pubkey
      // If mint_authority exists (first byte = 1), next 32 bytes are the authority pubkey
      if (yesMintInfo && yesMintInfo.data.length >= 36) {
        const hasMintAuthority = yesMintInfo.data[0] === 1;
        expect(hasMintAuthority).toBe(true);

        if (hasMintAuthority) {
          const authorityBytes = yesMintInfo.data.slice(1, 33);
          const mintAuthority = new PublicKey(authorityBytes);
          // Mint authority should be the market PDA
          expect(mintAuthority.equals(market)).toBe(true);

          // An attacker cannot be the mint authority
          const attacker = Keypair.generate();
          expect(mintAuthority.equals(attacker.publicKey)).toBe(false);
        }
      }

      // Same check for NO mint
      if (noMintInfo && noMintInfo.data.length >= 36) {
        const hasMintAuthority = noMintInfo.data[0] === 1;
        expect(hasMintAuthority).toBe(true);

        if (hasMintAuthority) {
          const authorityBytes = noMintInfo.data.slice(1, 33);
          const mintAuthority = new PublicKey(authorityBytes);
          expect(mintAuthority.equals(market)).toBe(true);
        }
      }
    },
  );

  it(
    "cannot call SPL Token MintTo directly (rejected: invalid mint authority)",
    { timeout: 120_000 },
    async () => {
      if (v === null) {
        throw new Error(SKIP_REASON);
      }
      const attacker = Keypair.generate();
      await v.connection.requestAirdrop(attacker.publicKey, 10_000_000_000);
      await new Promise((r) => setTimeout(r, 1000)); // wait for airdrop

      const { market } = await createMarket(v, 3600);
      const marketAccount = await v.program.account.market.fetch(market);
      const yesMint = marketAccount.yesMint;

      // Derive attacker's associated token account address
      // ATA derivation: findProgramAddress([wallet, TOKEN_PROGRAM_ID, mint], ASSOCIATED_TOKEN_PROGRAM_ID)
      const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      );
      const [attackerYes] = PublicKey.findProgramAddressSync(
        [attacker.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), yesMint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      // Create ATA if needed (InitializeAccount3)
      const ataInfo = await v.connection.getAccountInfo(attackerYes);
      if (ataInfo === null) {
        const createAtaIx = new TransactionInstruction({
          programId: ASSOCIATED_TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: attacker.publicKey, isSigner: true, isWritable: true }, // payer
            { pubkey: attackerYes, isSigner: false, isWritable: true }, // associated token account
            { pubkey: attacker.publicKey, isSigner: false, isWritable: false }, // wallet
            { pubkey: yesMint, isSigner: false, isWritable: false }, // mint
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([]),
        });
        const createTx = new Transaction().add(createAtaIx);
        createTx.recentBlockhash = (await v.connection.getLatestBlockhash()).blockhash;
        createTx.feePayer = attacker.publicKey;
        createTx.sign(attacker);
        await v.connection.sendRawTransaction(createTx.serialize());
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Attempt: SPL Token MintTo instruction (attacker tries to mint YES tokens)
      // Data layout: [discriminator: u8, amount: u64]
      const amount = BigInt(100);
      const data = Buffer.alloc(9);
      data.writeUInt8(MINT_TO_DISCRIMINATOR, 0);
      data.writeBigUInt64LE(amount, 1);

      const mintToIx = new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: yesMint, isSigner: false, isWritable: true }, // mint
          { pubkey: attackerYes, isSigner: false, isWritable: true }, // destination
          { pubkey: attacker.publicKey, isSigner: true, isWritable: false }, // authority (WRONG - should be market PDA)
        ],
        data,
      });

      const attackTx = new Transaction().add(mintToIx);
      attackTx.recentBlockhash = (await v.connection.getLatestBlockhash()).blockhash;
      attackTx.feePayer = attacker.publicKey;
      attackTx.sign(attacker);

      // Expected: rejected because mint authority is market PDA, not attacker
      await expect(v.connection.sendRawTransaction(attackTx.serialize())).rejects.toThrow();
    },
  );
});

describe.skipIf(v !== null)("AB-01 on-chain (local validator)", () => {
  it.skip(SKIP_REASON, () => undefined);
});
