import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { MarketsView } from "@/components/markets-view";

export default function HomePage() {
  return (
    <AppShell>
      <h2 className="sr-only">Markets</h2>
      <Suspense fallback={<div className="p-mer-4">Loading markets…</div>}>
        <MarketsView />
      </Suspense>
    </AppShell>
  );
}
