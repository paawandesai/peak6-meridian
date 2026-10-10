import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TickerTabs } from "./ticker-tabs";
import type { TickerGroup } from "@/lib/markets";

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

const createMockGroup = (ticker: string, marketCount: number, settledCount = 0): TickerGroup => ({
  ticker,
  markets: Array.from({ length: marketCount }, (_, i) => ({
    address: `${ticker}-market-${i}`,
    ticker,
    tradingDate: 20261010,
    strikeCents: BigInt((100 + i) * 100),
    closeTs: BigInt(Math.floor(Date.now() / 1000) + 28800), // 8 hours from now
    settled: i < settledCount,
    outcome: "None" as const,
    settlePriceScaled: 0n,
    pairsOutstanding: 100n,
    settledAt: 0n,
  })),
});

describe("TickerTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.clear();
    // Mock window.innerWidth for desktop by default
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1280,
    });
  });

  it("renders all 7 tickers plus All tab", () => {
    const tickerGroups: TickerGroup[] = [createMockGroup("AAPL", 3), createMockGroup("META", 2)];

    render(<TickerTabs tickerGroups={tickerGroups} />);

    expect(screen.getByRole("tab", { name: /AAPL/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /AMZN/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /GOOGL/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /META/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /MSFT/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /NVDA/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /TSLA/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /All/ })).toBeInTheDocument();
  });

  it("shows active market count for each ticker", () => {
    const tickerGroups: TickerGroup[] = [
      createMockGroup("AAPL", 3),
      createMockGroup("META", 5, 2), // 5 total, 2 settled = 3 active
    ];

    render(<TickerTabs tickerGroups={tickerGroups} />);

    const aaplTab = screen.getByRole("tab", { name: /AAPL/ });
    expect(aaplTab).toHaveTextContent("3 markets");

    const allTab = screen.getByRole("tab", { name: /All/ });
    expect(allTab).toHaveTextContent("6 markets"); // 3 AAPL + 3 META active
  });

  it("shows singular 'market' for count of 1", () => {
    const tickerGroups: TickerGroup[] = [createMockGroup("NVDA", 1)];

    render(<TickerTabs tickerGroups={tickerGroups} />);

    const nvdaTab = screen.getByRole("tab", { name: /NVDA/ });
    expect(nvdaTab).toHaveTextContent("1 market");
  });

  it("defaults to All on desktop", () => {
    const tickerGroups: TickerGroup[] = [createMockGroup("AAPL", 3)];

    render(<TickerTabs tickerGroups={tickerGroups} />);

    const allTab = screen.getByRole("tab", { name: /All/ });
    expect(allTab).toHaveAttribute("aria-selected", "true");
    expect(allTab).toHaveAttribute("tabindex", "0");
  });

  it("defaults to first ticker with markets on mobile", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 390,
    });

    const tickerGroups: TickerGroup[] = [
      createMockGroup("AMZN", 0),
      createMockGroup("GOOGL", 2),
      createMockGroup("META", 3),
    ];

    render(<TickerTabs tickerGroups={tickerGroups} />);

    // Trigger resize handler
    await waitFor(() => {
      fireEvent.resize(window);
    });

    // Should select GOOGL (first with markets)
    await waitFor(() => {
      const googlTab = screen.getByRole("tab", { name: /GOOGL/ });
      expect(googlTab).toHaveAttribute("aria-selected", "true");
    });
  });

  it("respects ?t= query parameter", () => {
    mockSearchParams.set("t", "META");
    const tickerGroups: TickerGroup[] = [createMockGroup("META", 2)];

    render(<TickerTabs tickerGroups={tickerGroups} />);

    const metaTab = screen.getByRole("tab", { name: /META/ });
    expect(metaTab).toHaveAttribute("aria-selected", "true");
  });

  it("updates URL when tab clicked", () => {
    const tickerGroups: TickerGroup[] = [createMockGroup("NVDA", 1)];

    render(<TickerTabs tickerGroups={tickerGroups} />);

    const nvdaTab = screen.getByRole("tab", { name: /NVDA/ });
    fireEvent.click(nvdaTab);

    expect(mockReplace).toHaveBeenCalledWith("/?t=NVDA", { scroll: false });
  });

  it("handles arrow right key navigation", () => {
    const tickerGroups: TickerGroup[] = [];
    render(<TickerTabs tickerGroups={tickerGroups} />);

    const aaplTab = screen.getByRole("tab", { name: /AAPL/ });
    const amznTab = screen.getByRole("tab", { name: /AMZN/ });

    aaplTab.focus();
    fireEvent.keyDown(aaplTab, { key: "ArrowRight" });

    expect(document.activeElement).toBe(amznTab);
    expect(mockReplace).toHaveBeenCalledWith("/?t=AMZN", { scroll: false });
  });

  it("handles arrow left key navigation", () => {
    mockSearchParams.set("t", "AMZN");
    const tickerGroups: TickerGroup[] = [];
    render(<TickerTabs tickerGroups={tickerGroups} />);

    const amznTab = screen.getByRole("tab", { name: /AMZN/ });
    const aaplTab = screen.getByRole("tab", { name: /AAPL/ });

    amznTab.focus();
    fireEvent.keyDown(amznTab, { key: "ArrowLeft" });

    expect(document.activeElement).toBe(aaplTab);
  });

  it("wraps around on arrow right from last tab", () => {
    mockSearchParams.set("t", "All");
    const tickerGroups: TickerGroup[] = [];
    render(<TickerTabs tickerGroups={tickerGroups} />);

    const allTab = screen.getByRole("tab", { name: /All/ });
    const aaplTab = screen.getByRole("tab", { name: /AAPL/ });

    allTab.focus();
    fireEvent.keyDown(allTab, { key: "ArrowRight" });

    expect(document.activeElement).toBe(aaplTab);
  });

  it("has focus ring on keyboard focus", () => {
    const tickerGroups: TickerGroup[] = [];
    render(<TickerTabs tickerGroups={tickerGroups} />);

    const aaplTab = screen.getByRole("tab", { name: /AAPL/ });
    expect(aaplTab).toHaveClass("focus:ring-2");
  });

  it("sets correct ARIA attributes", () => {
    mockSearchParams.set("t", "META");
    const tickerGroups: TickerGroup[] = [];
    render(<TickerTabs tickerGroups={tickerGroups} />);

    const metaTab = screen.getByRole("tab", { name: /META/ });
    const aaplTab = screen.getByRole("tab", { name: /AAPL/ });

    expect(metaTab).toHaveAttribute("aria-selected", "true");
    expect(metaTab).toHaveAttribute("aria-controls", "ticker-panel-META");
    expect(metaTab).toHaveAttribute("tabindex", "0");

    expect(aaplTab).toHaveAttribute("aria-selected", "false");
    expect(aaplTab).toHaveAttribute("tabindex", "-1");
  });

  it("handles Home key to jump to first tab", () => {
    mockSearchParams.set("t", "META");
    const tickerGroups: TickerGroup[] = [];
    render(<TickerTabs tickerGroups={tickerGroups} />);

    const metaTab = screen.getByRole("tab", { name: /META/ });
    const aaplTab = screen.getByRole("tab", { name: /AAPL/ });

    metaTab.focus();
    fireEvent.keyDown(metaTab, { key: "Home" });

    expect(document.activeElement).toBe(aaplTab);
  });

  it("handles End key to jump to last tab", () => {
    const tickerGroups: TickerGroup[] = [];
    render(<TickerTabs tickerGroups={tickerGroups} />);

    const aaplTab = screen.getByRole("tab", { name: /AAPL/ });
    const allTab = screen.getByRole("tab", { name: /All/ });

    aaplTab.focus();
    fireEvent.keyDown(aaplTab, { key: "End" });

    expect(document.activeElement).toBe(allTab);
  });
});
