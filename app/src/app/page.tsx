import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { MarketsPage } from "@/components/markets-page";

export default function HomePage() {
  return (
    <AppShell>
      <h2 className="sr-only">Markets</h2>
      <Suspense fallback={<div className="p-mer-4">Loading markets…</div>}>
        <MarketsPage />
      </Suspense>
    </AppShell>
  );
}
