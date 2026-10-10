#!/usr/bin/env tsx
/**
 * AC6 live devnet evidence: set OracleConfig with real RedStone signers
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { createMeridianProgram } from "@meridian/client";

const DEVNET_RPC = "https://api.devnet.solana.com";
const ADMIN_KEYPAIR_PATH = "/home/box/secrets/meridian-devnet/admin.json";
const PROGRAM_ID = new PublicKey("H8SBU6m8sGRvKudUGhroDP4oEMyvF9QDhVc9wTFESXSm");

// Real RedStone primary-prod signers from oracle-config.ts
const REDSTONE_PRIMARY_PROD_SIGNERS = [
  "0x8cdBF4FE234F106eFB28D84Ef466bBaf8616f8D9",
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
];

async function main() {
  // Dynamic import to workaround tsx module resolution
  const { BN } = await import("@coral-xyz/anchor");
  console.log("=== AC6 Devnet Evidence ===\n");

  const adminKeypairData = JSON.parse(readFileSync(ADMIN_KEYPAIR_PATH, "utf-8"));
  const admin = Keypair.fromSecretKey(new Uint8Array(adminKeypairData));
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  const connection = new Connection(DEVNET_RPC, "confirmed");
  const wallet = new Wallet(admin);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = createMeridianProgram(provider, PROGRAM_ID);

  const [oracleConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_config")],
    PROGRAM_ID,
  );

  console.log(`OracleConfig PDA: ${oracleConfigPda.toBase58()}\n`);

  // Convert Ethereum addresses to number[] arrays (not Buffer!)
  const signers = REDSTONE_PRIMARY_PROD_SIGNERS.map((hex) => {
    const bytes = Buffer.from(hex.slice(2), "hex");
    if (bytes.length !== 20) {
      throw new Error(`signer ${hex} is not 20 bytes`);
    }
    return Array.from(bytes); // Plain number[], not Buffer
  });

  console.log("Signers:");
  REDSTONE_PRIMARY_PROD_SIGNERS.forEach((addr, i) => {
    console.log(`  ${i + 1}. ${addr}`);
  });
  console.log(`Threshold: 3, Max delay: 600s\n`);

  try {
    // i64 must be BN from @coral-xyz/anchor
    const tx = await program.methods
      .setOracleConfig({
        signers,
        signerThreshold: 3,
        maxPackageDelaySecs: new BN(600), // i64 as BN
      })
      .accounts({ admin: admin.publicKey })
      .rpc({ commitment: "confirmed" });

    console.log(`✓ Success`);
    console.log(`  Signature: ${tx}`);
    console.log(`  Explorer:  https://explorer.solana.com/tx/${tx}?cluster=devnet\n`);

    const config = await program.account.oracleConfig.fetch(oracleConfigPda);
    console.log(`Verified: ${config.signers.length} signers, threshold ${config.signerThreshold}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed:`, message);
    if (typeof error === "object" && error !== null && "logs" in error) {
      const logs = error.logs as unknown[];
      logs.forEach((log) => console.error(`  ${String(log)}`));
    }
    console.error("\nFull error:");
    console.error(error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
