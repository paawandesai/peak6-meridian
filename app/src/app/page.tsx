"use client";

import { AppShell } from "@/components/app-shell";
import { MarketsView } from "@/components/markets-view";
import { useNow } from "@/components/use-now";

export default function HomePage() {
  const nowSecs = useNow();
  return (
    <AppShell>
      <h2 className="sr-only">Markets</h2>
      {nowSecs !== null && <MarketsView nowSecs={nowSecs} />}
    </AppShell>
  );
}
