"use client";

import { useWallet } from "@solana/wallet-adapter-react";

import { Countdown, DemoWalletCTA } from "./ui";
import { DEMO_WALLET_NAME } from "@/lib/demo-wallet";
import { UsdcBalance } from "./usdc-balance";
import { WalletButton } from "./wallet-button";
import type { AppConfig } from "@/lib/chain";
import type { MarketRow } from "@/lib/markets";
import { CLOCK_PLACEHOLDER, formatEtHm12, formatEtHms, nextClose } from "@/lib/time";

export const NAV_ITEMS = [
  { href: "/", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/history", label: "History" },
  { href: "/status", label: "Status" },
] as const;

export const PAUSE_BANNER_TEXT =
  "Paused: trading and minting stopped; cancel, withdraw and redeem still work";

/**
 * The next-close slot of the header (P0-1): session close with countdown, or empty states.
 * "NYSE close 4:00 PM ET · in 1:57:03" when session markets are open; after close or on weekends,
 * one of the design.md §3 empty states.
 */
export function NextCloseStatus({
  markets,
  nowSecs,
}: {
  readonly markets: readonly MarketRow[] | null;
  readonly nowSecs: number | null;
}) {
  // Until the clock has mounted and markets have loaded, a stable placeholder keeps the
  // server HTML and the first client render identical.
  if (nowSecs === null || markets === null) return <span className="mer-num">--:--</span>;
  const next = nextClose(markets, nowSecs);
  switch (next.kind) {
    case "countdown": {
      // "NYSE close 4:00 PM ET · in 1:57:03"
      const closeTime = next.hourET === 13 ? "1:00 PM ET" : "4:00 PM ET";
      return (
        <span>
          NYSE close {closeTime} · in <Countdown secondsLeft={next.secondsLeft} label="" />
        </span>
      );
    }
    case "none":
      return <span>No markets today</span>;
    case "closed-settling": {
      // "Closed · settling at 4:05 PM ET" (P0-1 AC2)
      const settlingTime = next.settlingAt ? ` at ${formatEtHm12(next.settlingAt)} ET` : "";
      return <span>Closed · settling{settlingTime}</span>;
    }
    case "settlement-delayed":
      return <span>Settlement delayed</span>;
    case "next-session":
      // "Next session Mon 9:30 AM ET" (P0-1 weekend AC)
      return (
        <span>
          Next session {next.dayName} {next.openTime} ET
        </span>
      );
    case "markets-closed":
      return <span>Markets closed</span>;
  }
}

/**
 * The page header: title, navigation, the ET clock, the next close, the global pause banner slot,
 * the connected wallet's balance and the wallet button. `nowSecs` is `null` until mount.
 */
export function AppHeader({
  nowSecs,
  markets,
  config,
  currentPath = "/",
  children,
}: {
  readonly nowSecs: number | null;
  readonly markets: readonly MarketRow[] | null;
  readonly config: AppConfig | null;
  readonly currentPath?: string;
  /** Extra header controls (for example the faucet button). */
  readonly children?: React.ReactNode;
}) {
  const { publicKey, select } = useWallet();

  const handleDemoConnect = () => {
    // Connect to demo wallet (demo wallet adapter)
    select(DEMO_WALLET_NAME as Parameters<typeof select>[0]);
  };

  return (
    <header className="border-b border-mer-rule bg-mer-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-mer-6 gap-y-mer-2 px-mer-4 py-mer-3">
        <h1 className="text-mer-lg font-bold">Meridian</h1>
        <nav aria-label="Main" className="flex flex-wrap gap-mer-4 text-mer-sm">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={item.href === currentPath ? "page" : undefined}
              className={`rounded-mer px-mer-1 underline-offset-4 ${item.href === currentPath ? "font-semibold underline" : "text-mer-ink-muted hover:underline"}`}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-x-mer-4 gap-y-mer-2 text-mer-sm">
          <span className="mer-num" data-testid="et-clock">
            {nowSecs === null ? CLOCK_PLACEHOLDER : `${formatEtHms(nowSecs)} ET`}
          </span>
          <span data-testid="next-close">
            <NextCloseStatus markets={markets} nowSecs={nowSecs} />
          </span>
          <UsdcBalance />
          {children}
          {publicKey === null ? <DemoWalletCTA onConnect={handleDemoConnect} /> : null}
          <WalletButton />
        </div>
      </div>
      {config?.paused === true ? (
        <p
          role="status"
          className="border-t border-mer-loss bg-mer-surface px-mer-4 py-mer-2 text-mer-sm text-mer-loss"
        >
          {PAUSE_BANNER_TEXT}
        </p>
      ) : null}
    </header>
  );
}
