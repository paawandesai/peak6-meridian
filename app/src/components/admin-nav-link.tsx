"use client";

import { useWallet } from "@solana/wallet-adapter-react";

import { useAsync } from "./use-async";
import { useReader } from "./reader-context";

/**
 * Admin navigation link (P1-8): shown only when the connected wallet matches `Config.admin`.
 *
 * **Usage**: This component is ready to be added to the app header's navigation. To wire it in,
 * add it to the NAV_ITEMS array in `app-header.tsx` or render it conditionally near the existing
 * nav items. The component handles the admin check internally.
 *
 * Example integration in AppHeader (when P0-1/P0-6 allow header changes):
 * ```tsx
 * <nav aria-label="Main" className="flex flex-wrap gap-mer-4 text-mer-sm">
 *   {NAV_ITEMS.map((item) => ( ... ))}
 *   <AdminNavLink currentPath={currentPath} />
 * </nav>
 * ```
 */
export function AdminNavLink({ currentPath = "/" }: { readonly currentPath?: string }) {
  const reader = useReader();
  const { publicKey } = useWallet();
  const config = useAsync(() => reader.getConfig(), [reader]);

  // Only render for the admin wallet
  const isAdmin =
    publicKey !== null && config.status === "ready" && config.value.admin === publicKey.toBase58();

  if (!isAdmin) return null;

  const href = "/admin";
  return (
    <a
      href={href}
      aria-current={href === currentPath ? "page" : undefined}
      className={`rounded-mer px-mer-1 underline-offset-4 ${href === currentPath ? "font-semibold underline" : "text-mer-ink-muted hover:underline"}`}
    >
      Admin
    </a>
  );
}
