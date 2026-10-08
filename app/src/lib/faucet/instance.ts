/** Builds the process-wide faucet from the server environment. Server-only: reads secrets. */
import { Connection } from "@solana/web3.js";

import { connectionChain } from "./chain";
import { type FaucetEnv, parseFaucetEnv } from "./env";
import { createFaucet, type Faucet, type LogFn } from "./faucet";

export type Alerter = (text: string) => Promise<void>;

/** POSTs a Discord/Slack-compatible alert; the URL is never logged or returned. */
export function webhookAlerter(url: string | undefined, fetcher: typeof fetch): Alerter {
  return async (text) => {
    if (url === undefined) return;
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, text }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`webhook status ${response.status}`);
  };
}

export function createFaucetFromEnv(
  env: FaucetEnv,
  options: { readonly fetcher?: typeof fetch; readonly log?: LogFn } = {},
): Faucet {
  const settings = parseFaucetEnv(env);
  return createFaucet({
    chain: connectionChain(new Connection(settings.rpcUrl, "confirmed")),
    keypair: settings.keypair,
    mint: settings.mint,
    amountBaseUnits: settings.amountBaseUnits,
    minLamports: settings.minLamports,
    cluster: settings.cluster,
    rpcUrl: settings.rpcUrl,
    alert: webhookAlerter(settings.alertWebhookUrl, options.fetcher ?? fetch),
    alertCooldownMs: settings.alertCooldownMs,
    now: () => Date.now(),
    log: options.log ?? ((entry) => console.warn(JSON.stringify(entry))),
  });
}
