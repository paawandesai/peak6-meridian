/**
 * Public browser config. Only `NEXT_PUBLIC_*` variables are read here (NFR-16); anything else
 * would be absent from the client bundle anyway, and the build test fails if one leaks in.
 */
import { MERIDIAN_PROGRAM_ID } from "@meridian/client";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

const publicKey = z
  .string()
  .trim()
  .transform((value, ctx) => {
    try {
      return new PublicKey(value);
    } catch {
      ctx.addIssue({ code: "custom", message: `not a base58 public key: ${value}` });
      return z.NEVER;
    }
  });

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const schema = z.object({
  cluster: z.enum(["localnet", "devnet"]),
  rpcUrl: z.url(),
  programId: publicKey,
  usdcMint: publicKey.optional(),
});

export type PublicConfig = z.infer<typeof schema>;

/** The raw values, keyed like the schema. */
export type RawPublicConfig = {
  readonly cluster?: string | undefined;
  readonly rpcUrl?: string | undefined;
  readonly programId?: string | undefined;
  readonly usdcMint?: string | undefined;
};

/** Validates raw values, filling defaults for a local validator; throws with context. */
export function parsePublicConfig(raw: RawPublicConfig): PublicConfig {
  const result = schema.safeParse({
    cluster: emptyToUndefined(raw.cluster) ?? "localnet",
    rpcUrl: emptyToUndefined(raw.rpcUrl) ?? "http://127.0.0.1:8899",
    programId: emptyToUndefined(raw.programId) ?? MERIDIAN_PROGRAM_ID.toBase58(),
    usdcMint: emptyToUndefined(raw.usdcMint),
  });
  if (!result.success) {
    throw new Error(`invalid NEXT_PUBLIC_* configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Reads the build-time inlined `NEXT_PUBLIC_*` variables (each must be named literally). */
export function loadPublicConfig(): PublicConfig {
  return parsePublicConfig({
    cluster: process.env.NEXT_PUBLIC_CLUSTER,
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
    programId: process.env.NEXT_PUBLIC_PROGRAM_ID,
    usdcMint: process.env.NEXT_PUBLIC_USDC_MINT,
  });
}
