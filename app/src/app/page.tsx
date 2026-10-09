import { AppShell } from "@/components/app-shell";
import { MarketsView } from "@/components/markets-view";
import { tradeHref } from "@/app/trade/_lib/href";

export default function HomePage() {
  return (
    <AppShell>
      <h2 className="sr-only">Markets</h2>
      <MarketsView tradeHref={tradeHref} />
    </AppShell>
  );
}
