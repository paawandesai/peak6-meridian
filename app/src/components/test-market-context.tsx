/**
 * Test market visibility context (P0-1 AC4): manages the "Show test markets (N)" disclosure
 * state globally. All pages (Markets, Portfolio, Status, History, Trade) filter to session
 * markets by default, and reveal test markets only when the toggle is clicked.
 */
"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type TestMarketContextValue = {
  readonly showTestMarkets: boolean;
  readonly setShowTestMarkets: (show: boolean) => void;
};

const TestMarketContext = createContext<TestMarketContextValue | null>(null);

export function TestMarketProvider({ children }: { readonly children: ReactNode }) {
  const [showTestMarkets, setShowTestMarkets] = useState(false);
  return (
    <TestMarketContext.Provider value={{ showTestMarkets, setShowTestMarkets }}>
      {children}
    </TestMarketContext.Provider>
  );
}

export function useTestMarkets(): TestMarketContextValue {
  const ctx = useContext(TestMarketContext);
  if (ctx === null) {
    throw new Error("useTestMarkets must be used within TestMarketProvider");
  }
  return ctx;
}
