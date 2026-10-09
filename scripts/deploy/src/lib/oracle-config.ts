import { readFileSync } from "node:fs";

import { z } from "zod";

/** RedStone oracle configuration for M2-15 / D-054. */
export type OracleConfigParams = {
  /** RedStone signer Ethereum addresses (20 bytes hex, up to 8). */
  readonly signers: readonly string[];
  /** Minimum valid signers required (≥ 1, ≤ signers.length). */
  readonly signerThreshold: number;
  /** Maximum package age in seconds (default 600 = 10 min). */
  readonly maxPackageDelaySecs: number;
};

const ethereumAddressHex = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 40-character hex Ethereum address prefixed with 0x");

const oracleConfigSchema = z.object({
  signers: z.array(ethereumAddressHex).min(1).max(8),
  signerThreshold: z.number().int().min(1),
  maxPackageDelaySecs: z.number().int().positive(),
});

/**
 * Reads and validates an oracle config JSON file.
 *
 * Format:
 * ```json
 * {
 *   "signers": ["0x...", "0x...", ...],
 *   "signerThreshold": 3,
 *   "maxPackageDelaySecs": 600
 * }
 * ```
 */
export function readOracleConfigFile(path: string): OracleConfigParams {
  const text = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`oracle config ${path}: invalid JSON: ${String(error)}`);
  }
  const result = oracleConfigSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`oracle config ${path}: ${problems.join("; ")}`);
  }
  const config = result.data;
  if (config.signerThreshold > config.signers.length) {
    throw new Error(
      `oracle config ${path}: signerThreshold (${config.signerThreshold}) > signers.length (${config.signers.length})`,
    );
  }
  return config;
}

/**
 * Converts hex Ethereum address (0x-prefixed) to 20-byte array.
 *
 * @example
 * ethereumAddressToBytes("0x1234...") → [0x12, 0x34, ...]
 */
export function ethereumAddressToBytes(address: string): number[] {
  if (!address.startsWith("0x") || address.length !== 42) {
    throw new Error(`invalid Ethereum address: ${address}`);
  }
  const hex = address.slice(2);
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

/**
 * RedStone redstone-primary-prod signer addresses (M2-15, D-054).
 *
 * Source: https://docs.redstone.finance/docs/smart-contract-devs/get-started/redstone-core
 * (redstone-primary-prod signers from official RedStone documentation)
 *
 * TODO: Replace with actual addresses from RedStone docs when web access available.
 * These are placeholder addresses for development - MUST be updated with real
 * redstone-primary-prod signer addresses before devnet deploy.
 */
export const REDSTONE_PRIMARY_PROD_SIGNERS = [
  "0x0000000000000000000000000000000000000001", // Signer 1 (PLACEHOLDER)
  "0x0000000000000000000000000000000000000002", // Signer 2 (PLACEHOLDER)
  "0x0000000000000000000000000000000000000003", // Signer 3 (PLACEHOLDER)
  "0x0000000000000000000000000000000000000004", // Signer 4 (PLACEHOLDER)
  "0x0000000000000000000000000000000000000005", // Signer 5 (PLACEHOLDER)
] as const;

/** Default oracle configuration for redstone-primary-prod (M2-15, D-054). */
export const DEFAULT_ORACLE_CONFIG: OracleConfigParams = {
  signers: [...REDSTONE_PRIMARY_PROD_SIGNERS],
  signerThreshold: 3,
  maxPackageDelaySecs: 600,
};
