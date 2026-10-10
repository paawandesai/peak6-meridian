/** POST /api/faucet {wallet}: mints a fixed amount of test-USDC, once per wallet per 24 h (M2-09). */
import { NextResponse } from "next/server";
import { z } from "zod";

import { createFaucetFromEnv } from "@/lib/faucet/instance";
import type { Faucet } from "@/lib/faucet/faucet";

export const dynamic = "force-dynamic";

const body = z.object({ wallet: z.string().min(32).max(44) });

let faucet: Faucet | undefined;

function getFaucet(): Faucet {
  faucet ??= createFaucetFromEnv({
    FAUCET_KEYPAIR: process.env.FAUCET_KEYPAIR,
    FAUCET_AMOUNT_USDC: process.env.FAUCET_AMOUNT_USDC,
    FAUCET_MIN_LAMPORTS: process.env.FAUCET_MIN_LAMPORTS,
    FAUCET_ALERT_COOLDOWN_SEC: process.env.FAUCET_ALERT_COOLDOWN_SEC,
    ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL,
    USDC_MINT: process.env.USDC_MINT,
    SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
    SOLANA_RPC_URL: process.env.MERIDIAN_DEVNET_RPC_URL?.trim() || process.env.SOLANA_RPC_URL,
  });
  return faucet;
}

export async function POST(request: Request): Promise<NextResponse> {
  let wallet: string;
  try {
    wallet = body.parse(await request.json()).wallet;
  } catch {
    return NextResponse.json({ error: 'Send JSON like {"wallet": "<address>"}.' }, { status: 400 });
  }
  let active: Faucet;
  try {
    active = getFaucet();
  } catch (error) {
    // Name the variable, never its value; the client only learns the faucet is not set up.
    console.warn(
      JSON.stringify({
        event: "faucet_not_configured",
        detail:
          (error as Error).name === "FaucetConfigError"
            ? (error as Error).message
            : (error as Error).name,
      }),
    );
    return NextResponse.json({ error: "The faucet is not configured." }, { status: 500 });
  }
  const result = await active.claim(wallet);
  if (result.status === 200) {
    return NextResponse.json(
      { signature: result.signature, amount_base_units: result.amountBaseUnits.toString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { error: result.error },
    { status: result.status, headers: { "Cache-Control": "no-store" } },
  );
}
