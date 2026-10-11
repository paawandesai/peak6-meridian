"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { z } from "zod";

import { formatUsdcBalance } from "@/lib/display";
import {
  type FaucetSuccess,
  faucetSuccessSchema,
  formatLamportsAsSol,
} from "@/lib/faucet/response";

const errorSchema = z.object({ error: z.string() });

type State =
  | { readonly status: "idle" }
  | { readonly status: "working" }
  | { readonly status: "done"; readonly text: string; readonly warning?: string }
  | { readonly status: "failed"; readonly text: string };

/** What a successful claim says: the test-USDC, the fee SOL if any, and why none was sent. */
function doneState(ok: FaucetSuccess): Extract<State, { status: "done" }> {
  const usdc = formatUsdcBalance(BigInt(ok.amount_base_units));
  if (ok.fee_sol_status === "sent") {
    const sol = formatLamportsAsSol(BigInt(ok.fee_sol_lamports));
    return { status: "done", text: `Received ${usdc} and ${sol} for network fees.` };
  }
  if (ok.fee_sol_status === "faucet_low") {
    return {
      status: "done",
      text: `Received ${usdc}.`,
      warning: ok.fee_sol_message ?? "The faucet sent no SOL for network fees.",
    };
  }
  return { status: "done", text: `Received ${usdc}.` };
}

/**
 * "Get test-USDC": asks the server faucet for the connected wallet. Renders nothing until a
 * wallet is connected. The server's message is shown as is (for a 429 it states the 24 h rule).
 */
export function FaucetButton() {
  const { publicKey } = useWallet();
  const [state, setState] = useState<State>({ status: "idle" });
  if (publicKey === null) return null;

  async function claim(wallet: string): Promise<void> {
    setState({ status: "working" });
    try {
      const response = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const body: unknown = await response.json();
      if (response.ok) {
        setState(doneState(faucetSuccessSchema.parse(body)));
      } else {
        setState({ status: "failed", text: errorSchema.parse(body).error });
      }
    } catch {
      setState({ status: "failed", text: "The faucet could not be reached; try again shortly." });
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="rounded border border-slate-300 px-3 py-1 text-sm font-medium disabled:opacity-50"
        disabled={state.status === "working"}
        onClick={() => void claim(publicKey.toBase58())}
      >
        Get test-USDC
      </button>
      {state.status === "working" && <span role="status">Requesting…</span>}
      {state.status === "done" && <span role="status">{state.text}</span>}
      {state.status === "done" && state.warning !== undefined && (
        <span role="alert">{state.warning}</span>
      )}
      {state.status === "failed" && <span role="alert">{state.text}</span>}
    </span>
  );
}
