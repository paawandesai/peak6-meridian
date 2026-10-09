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
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
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
 * RedStone redstone-primary-prod authorized signer addresses (M2-15, D-054).
 *
 * Source: @redstone-finance/sdk@1.0.0
 * File: package/src/registry/initial-state.json
 * Extracted via: npm pack @redstone-finance/sdk && tar -xzf redstone-finance-sdk-1.0.0.tgz
 * Query: nodes[] | select(.dataServiceId == "redstone-primary-prod") | .evmAddress
 *
 * These are the first 5 Ethereum addresses from the redstone-primary-prod data service nodes:
 * - keyrock-1: 0x8cdBF4FE234F106eFB28D84Ef466bBaf8616f8D9
 * - altair:    0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774
 * - wayfarer:  0xdEB22f54738d54976C4c0fe5ce6d408E40d88499
 * - morpheus:  0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202
 * - ciri:      0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE
 */
export const REDSTONE_PRIMARY_PROD_SIGNERS = [
  "0x8cdBF4FE234F106eFB28D84Ef466bBaf8616f8D9",
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
] as const;

/** Default oracle configuration for redstone-primary-prod (M2-15, D-054). */
export const DEFAULT_ORACLE_CONFIG: OracleConfigParams = {
  signers: [...REDSTONE_PRIMARY_PROD_SIGNERS],
  signerThreshold: 3,
  maxPackageDelaySecs: 600,
};
