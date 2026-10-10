import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTickerSelection } from "./use-ticker-selection";

// Mock next/navigation
const mockReplace = vi.fn();
const mockSearchParams = new Map<string, string>();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/",
  useSearchParams: () => ({
    get: (key: string) => mockSearchParams.get(key) ?? null,
    toString: () => {
      const params = new URLSearchParams();
      mockSearchParams.forEach((value, key) => params.set(key, value));
      return params.toString();
    },
  }),
}));

describe("useTickerSelection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.clear();
    localStorage.clear();
  });

  it("defaults to All when no param or localStorage", () => {
    const { result } = renderHook(() => useTickerSelection());
    const [ticker] = result.current;

    expect(ticker).toBe("All");
  });

  it("uses custom default when provided", () => {
    const { result } = renderHook(() => useTickerSelection({ defaultTicker: "AAPL" }));
    const [ticker] = result.current;

    expect(ticker).toBe("AAPL");
  });

  it("reads from ?t= query param on mount", () => {
    mockSearchParams.set("t", "META");

    const { result } = renderHook(() => useTickerSelection());
    const [ticker] = result.current;

    expect(ticker).toBe("META");
  });

  it("reads from localStorage when no query param", () => {
    localStorage.setItem("meridian-last-ticker", "NVDA");

    const { result } = renderHook(() => useTickerSelection());
    const [ticker] = result.current;

    expect(ticker).toBe("NVDA");
  });

  it("prefers query param over localStorage", () => {
    mockSearchParams.set("t", "GOOGL");
    localStorage.setItem("meridian-last-ticker", "TSLA");

    const { result } = renderHook(() => useTickerSelection());
    const [ticker] = result.current;

    expect(ticker).toBe("GOOGL");
  });

  it("updates URL when ticker changed", () => {
    const { result } = renderHook(() => useTickerSelection());

    act(() => {
      const [, setTicker] = result.current;
      setTicker("AMZN");
    });

    expect(mockReplace).toHaveBeenCalledWith("/?t=AMZN", { scroll: false });
  });

  it("persists to localStorage when ticker changed", () => {
    const { result } = renderHook(() => useTickerSelection());

    act(() => {
      const [, setTicker] = result.current;
      setTicker("MSFT");
    });

    expect(localStorage.getItem("meridian-last-ticker")).toBe("MSFT");
  });

  it("updates state when ticker changed", () => {
    const { result } = renderHook(() => useTickerSelection());

    act(() => {
      const [, setTicker] = result.current;
      setTicker("TSLA");
    });

    const [ticker] = result.current;
    expect(ticker).toBe("TSLA");
  });

  it("syncs URL from localStorage when no query param", () => {
    localStorage.setItem("meridian-last-ticker", "AAPL");

    renderHook(() => useTickerSelection());

    expect(mockReplace).toHaveBeenCalledWith("/?t=AAPL", { scroll: false });
  });

  it("ignores invalid ticker in query param", () => {
    mockSearchParams.set("t", "INVALID");

    const { result } = renderHook(() => useTickerSelection());
    const [ticker] = result.current;

    expect(ticker).toBe("All"); // Falls back to default
  });

  it("ignores invalid ticker in localStorage", () => {
    localStorage.setItem("meridian-last-ticker", "INVALID");

    const { result } = renderHook(() => useTickerSelection());
    const [ticker] = result.current;

    expect(ticker).toBe("All"); // Falls back to default
  });
});
