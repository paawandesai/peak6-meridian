"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { z } from "zod";

import { formatUsdcBalance } from "@/lib/display";

const successSchema = z.object({ signature: z.string(), amount_base_units: z.string() });
const errorSchema = z.object({ error: z.string() });

type State =
  | { readonly status: "idle" }
  | { readonly status: "working" }
  | { readonly status: "done"; readonly text: string }
  | { readonly status: "failed"; readonly text: string };

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
        const ok = successSchema.parse(body);
        setState({
          status: "done",
          text: `Received ${formatUsdcBalance(BigInt(ok.amount_base_units))}.`,
        });
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
      {state.status === "failed" && <span role="alert">{state.text}</span>}
    </span>
  );
}
