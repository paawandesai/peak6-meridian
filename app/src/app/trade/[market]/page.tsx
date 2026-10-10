import { TradeShell } from "../_components/trade-shell";

export default async function TradePage({
  params,
}: {
  readonly params: Promise<{ readonly market: string }>;
}) {
  const { market } = await params;
  return <TradeShell address={market} />;
}
