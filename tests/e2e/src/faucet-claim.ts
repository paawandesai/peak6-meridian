/**
 * Claims test-USDC for a wallet from the app's faucet (`POST /api/faucet`, M2-09). The fetch is
 * injected so tests never touch a network. A 429 (the wallet already claimed in the last 24 h) is
 * not an error here: the caller checks the balance afterwards.
 */
import { z } from "zod";

export type FaucetClaim =
  { readonly kind: "claimed"; readonly signature: string } | { readonly kind: "already-claimed" };

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

const okBody = z.object({ signature: z.string().min(1) });
const errBody = z.object({ error: z.string() });
const TIMEOUT_MS = 30_000;

export async function claimFromFaucet(
  fetchImpl: FetchLike,
  faucetUrl: string,
  wallet: string,
): Promise<FaucetClaim> {
  const endpoint = `${faucetUrl.replace(/\/+$/, "")}/api/faucet`;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // The URL is not echoed: it may carry credentials.
    throw new Error("the faucet is unreachable (FAUCET_URL); is the app running?");
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (response.status === 200) {
    const parsed = okBody.safeParse(json);
    if (!parsed.success) throw new Error("the faucet answered 200 without a signature");
    return { kind: "claimed", signature: parsed.data.signature };
  }
  if (response.status === 429) return { kind: "already-claimed" };
  const message = errBody.safeParse(json);
  throw new Error(
    `the faucet refused the claim for ${wallet} (HTTP ${response.status}${message.success ? `: ${message.data.error}` : ""})`,
  );
}
