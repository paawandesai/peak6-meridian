import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Meridian",
  description: "Binary 0DTE outcome markets on the MAG7 stocks (Solana devnet, no real funds).",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
