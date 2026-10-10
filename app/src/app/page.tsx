"use client";

import { AppShell } from "@/components/app-shell";
import { MarketsView } from "@/components/markets-view";

export default function HomePage() {
  return (
    <AppShell>
      <h2 className="sr-only">Markets</h2>
      <MarketsView />
    </AppShell>
  );
}
