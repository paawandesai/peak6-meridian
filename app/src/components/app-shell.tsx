"use client";

import type { ReactNode } from "react";

import { AppHeader } from "./app-header";
import { FaucetButton } from "./faucet-button";
import { Providers } from "./providers";
import { useReader } from "./reader-context";
import { useAsync } from "./use-async";
import { useNow } from "./use-now";

/** Content width: `narrow` suits the Markets ladder, `wide` the table-heavy pages. */
export type ShellWidth = "narrow" | "wide";
const WIDTH: Record<ShellWidth, string> = { narrow: "max-w-3xl", wide: "max-w-5xl" };

/** Header data: the markets (for the next close) and the config (for the pause banner). */
function Shell({ children, width }: { readonly children: ReactNode; readonly width: ShellWidth }) {
  const reader = useReader();
  const nowSecs = useNow();
  const markets = useAsync(() => reader.listMarkets(), [reader]);
  const config = useAsync(() => reader.getConfig(), [reader]);
  return (
    <>
      <AppHeader
        nowSecs={nowSecs}
        markets={markets.status === "ready" ? markets.value : null}
        config={config.status === "ready" ? config.value : null}
      >
        <FaucetButton />
      </AppHeader>
      <main className={`mx-auto ${WIDTH[width]} px-mer-4 py-mer-6`}>{children}</main>
    </>
  );
}

/**
 * The one page frame: providers (wallet, reader) plus the shared header, around the page's own
 * content. Every page mounts its view as `children`; none keeps a copy of this wiring.
 */
export function AppShell({
  children,
  width = "narrow",
}: {
  readonly children: ReactNode;
  readonly width?: ShellWidth;
}) {
  return (
    <Providers>
      <Shell width={width}>{children}</Shell>
    </Providers>
  );
}
