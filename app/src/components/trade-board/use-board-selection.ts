"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { BOARD_TICKERS, type BoardTicker } from "./types";

/** The board's selection as the URL holds it (docs/redesign-spec.md §2.4). */
export type BoardSelection = {
  readonly ticker: BoardTicker | null;
  /** A market address; only with a ticker. Whether it is on that ticker's ladder is the board's call. */
  readonly market: string | null;
};

type ParamReader = { get(name: string): string | null };

/** A Solana address: base58, 32 to 44 characters. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const isBoardTicker = (value: string): value is BoardTicker =>
  (BOARD_TICKERS as readonly string[]).includes(value);

/** `?t=` and `?m=` to a selection. Unknown tickers, malformed addresses and `m` without `t` are ignored. */
export function parseBoardSelection(params: ParamReader): BoardSelection {
  const t = params.get("t");
  if (t === null || !isBoardTicker(t)) return { ticker: null, market: null };
  const m = params.get("m");
  return { ticker: t, market: m !== null && ADDRESS.test(m) ? m : null };
}

/** The query string for `selection`, keeping every other parameter of `current`. */
export function boardSelectionQuery(current: string, selection: BoardSelection): string {
  const params = new URLSearchParams(current);
  params.delete("t");
  params.delete("m");
  if (selection.ticker !== null) {
    params.set("t", selection.ticker);
    if (selection.market !== null) params.set("m", selection.market);
  }
  return params.toString();
}

export type BoardSelectionControls = {
  readonly selection: BoardSelection;
  readonly selectTicker: (ticker: BoardTicker) => void;
  readonly selectMarket: (ticker: BoardTicker, market: string) => void;
  readonly clear: () => void;
};

/**
 * The board's selected ticker and strike, held in the URL (`?t=` / `?m=`) so a link lands on it and
 * back/forward restore it. The URL is the only state: the selection is read from it on every
 * render, and changes go through `router.replace` with `scroll: false`, as `useTickerSelection` does.
 */
export function useBoardSelection(): BoardSelectionControls {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const query = params.toString();

  const go = useCallback(
    (next: BoardSelection) => {
      const search = boardSelectionQuery(query, next);
      router.replace(search === "" ? pathname : `${pathname}?${search}`, { scroll: false });
    },
    [query, pathname, router],
  );

  return {
    selection: parseBoardSelection(params),
    selectTicker: useCallback((ticker) => go({ ticker, market: null }), [go]),
    selectMarket: useCallback((ticker, market) => go({ ticker, market }), [go]),
    clear: useCallback(() => go({ ticker: null, market: null }), [go]),
  };
}
