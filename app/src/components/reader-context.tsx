"use client";

import { createContext, type ReactNode, useContext } from "react";

import type { MeridianReader } from "@/lib/chain";

const ReaderContext = createContext<MeridianReader | null>(null);

export function ReaderProvider({
  reader,
  children,
}: {
  readonly reader: MeridianReader;
  readonly children: ReactNode;
}) {
  return <ReaderContext.Provider value={reader}>{children}</ReaderContext.Provider>;
}

export function useReader(): MeridianReader {
  const reader = useContext(ReaderContext);
  if (reader === null) {
    throw new Error("useReader must be used inside <ReaderProvider>");
  }
  return reader;
}
