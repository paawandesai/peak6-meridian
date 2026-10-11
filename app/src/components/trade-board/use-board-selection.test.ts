import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOARD_TICKERS } from "./types";
import { boardSelectionQuery, parseBoardSelection, useBoardSelection } from "./use-board-selection";

const ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const ADDR2 = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

let search = "";
const replace = vi.fn((url: string) => {
  search = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search),
}));

beforeEach(() => {
  search = "";
  replace.mockClear();
});

const params = (query: string) => new URLSearchParams(query);

describe("parseBoardSelection (AC10)", () => {
  it("reads a ticker, and a ticker with a market", () => {
    expect(parseBoardSelection(params("t=NVDA"))).toEqual({ ticker: "NVDA", market: null });
    expect(parseBoardSelection(params(`t=NVDA&m=${ADDR}`))).toEqual({
      ticker: "NVDA",
      market: ADDR,
    });
  });

  it("ignores unknown tickers, `All`, lowercase, malformed addresses and m without t", () => {
    for (const q of ["", "t=SPY", "t=All", "t=nvda", `m=${ADDR}`, `t=SPY&m=${ADDR}`]) {
      expect(parseBoardSelection(params(q)), q).toEqual({ ticker: null, market: null });
    }
    for (const m of ["x", "0OIl".repeat(10), `${ADDR}x`.repeat(2)]) {
      expect(parseBoardSelection(params(`t=AAPL&m=${m}`)), m).toEqual({
        ticker: "AAPL",
        market: null,
      });
    }
  });

  it("round-trips every selection through the query string (property)", () => {
    const address = fc.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom(...BOARD_TICKERS), { nil: null }),
        fc.option(address, { nil: null }),
        (ticker, market) => {
          const selection = { ticker, market: ticker === null ? null : market };
          expect(parseBoardSelection(params(boardSelectionQuery("replay=x", selection)))).toEqual(
            selection,
          );
        },
      ),
    );
  });
});

describe("boardSelectionQuery", () => {
  it("keeps other parameters and drops t and m when clearing", () => {
    expect(boardSelectionQuery(`a=1&t=AAPL&m=${ADDR}`, { ticker: null, market: null })).toBe("a=1");
    expect(boardSelectionQuery("a=1", { ticker: "TSLA", market: null })).toBe("a=1&t=TSLA");
  });
});

describe("useBoardSelection", () => {
  it("reads the selection from the URL on every render (back/forward)", () => {
    search = `t=META&m=${ADDR}`;
    const { result, rerender } = renderHook(() => useBoardSelection());
    expect(result.current.selection).toEqual({ ticker: "META", market: ADDR });
    search = "t=AMZN"; // the browser went back
    rerender();
    expect(result.current.selection).toEqual({ ticker: "AMZN", market: null });
  });

  it("selects a ticker, then a strike, then clears, with replace and no scroll", () => {
    const { result, rerender } = renderHook(() => useBoardSelection());
    act(() => result.current.selectTicker("NVDA"));
    expect(replace).toHaveBeenLastCalledWith("/?t=NVDA", { scroll: false });
    rerender();
    act(() => result.current.selectMarket("NVDA", ADDR2));
    expect(replace).toHaveBeenLastCalledWith(`/?t=NVDA&m=${ADDR2}`, { scroll: false });
    rerender();
    expect(result.current.selection).toEqual({ ticker: "NVDA", market: ADDR2 });
    act(() => result.current.clear());
    expect(replace).toHaveBeenLastCalledWith("/", { scroll: false });
  });
});
