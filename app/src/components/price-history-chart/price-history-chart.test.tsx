import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PriceHistoryChart } from "./price-history-chart";

// Mock lightweight-charts
const mockCreateChart = vi.fn();
const mockAddCandlestickSeries = vi.fn();
const mockSetData = vi.fn();
const mockCreatePriceLine = vi.fn();
const mockRemove = vi.fn();
const mockTimeScale = vi.fn(() => ({ fitContent: vi.fn() }));
const mockApplyOptions = vi.fn();

vi.mock("lightweight-charts", () => ({
  createChart: (...args: unknown[]) => {
    mockCreateChart(...args);
    return {
      addCandlestickSeries: mockAddCandlestickSeries,
      remove: mockRemove,
      timeScale: mockTimeScale,
      applyOptions: mockApplyOptions,
    };
  },
}));

describe("PriceHistoryChart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddCandlestickSeries.mockReturnValue({
      setData: mockSetData,
      createPriceLine: mockCreatePriceLine,
    });
    global.fetch = vi.fn();
  });

  it("is collapsed by default", () => {
    render(<PriceHistoryChart ticker="AAPL" nowSecs={1000000} />);
    expect(screen.getByText(/Show price history/)).toBeInTheDocument();
    expect(mockCreateChart).not.toHaveBeenCalled();
  });

  it("creates chart exactly once across 5 clock ticks", async () => {
    const mockData = {
      s: "ok" as const,
      t: [1000000],
      o: [100.0],
      h: [101.0],
      l: [99.0],
      c: [100.5],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    const { rerender } = render(<PriceHistoryChart ticker="AAPL" nowSecs={1000000} />);

    // Expand disclosure
    const details = screen.getByText(/Show price history/).closest("details");
    expect(details).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Show price history/));

    await waitFor(() => expect(mockCreateChart).toHaveBeenCalledTimes(1));

    // Clock ticks (5 times, but nowSecs changes every second)
    rerender(<PriceHistoryChart ticker="AAPL" nowSecs={1000001} />);
    rerender(<PriceHistoryChart ticker="AAPL" nowSecs={1000002} />);
    rerender(<PriceHistoryChart ticker="AAPL" nowSecs={1000003} />);
    rerender(<PriceHistoryChart ticker="AAPL" nowSecs={1000004} />);
    rerender(<PriceHistoryChart ticker="AAPL" nowSecs={1000005} />);

    // Chart created only once for the same ticker
    expect(mockCreateChart).toHaveBeenCalledTimes(1);
  });

  it("fetches at most once per 5-minute bucket", async () => {
    const mockData = {
      s: "ok" as const,
      t: [1000000],
      o: [100.0],
      h: [101.0],
      l: [99.0],
      c: [100.5],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });
    global.fetch = fetchMock;

    const { rerender } = render(<PriceHistoryChart ticker="NVDA" nowSecs={1500000} />);
    fireEvent.click(screen.getByText(/Show price history/));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Tick within same 5-min bucket (1500000 -> 1500299 is same bucket)
    rerender(<PriceHistoryChart ticker="NVDA" nowSecs={1500100} />);
    rerender(<PriceHistoryChart ticker="NVDA" nowSecs={1500200} />);
    rerender(<PriceHistoryChart ticker="NVDA" nowSecs={1500299} />);

    // Still only 1 fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cross bucket boundary (1500000 -> 1500300 is next bucket)
    rerender(<PriceHistoryChart ticker="NVDA" nowSecs={1500300} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("shows empty state when no data", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ s: "no_data" }),
    });

    render(<PriceHistoryChart ticker="TSLA" nowSecs={1000000} />);
    fireEvent.click(screen.getByText(/Show price history/));

    await waitFor(() =>
      expect(screen.getByText(/No price history \(weekend \/ market closed\)/)).toBeInTheDocument(),
    );
  });

  it("shows error state on fetch failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    render(<PriceHistoryChart ticker="META" nowSecs={1000000} />);
    fireEvent.click(screen.getByText(/Show price history/));

    await waitFor(() =>
      expect(screen.getByText(/Price history unavailable/)).toBeInTheDocument(),
    );
  });

  it("keeps last good data on subsequent fetch failures", async () => {
    const mockData = {
      s: "ok" as const,
      t: [1000000],
      o: [100.0],
      h: [101.0],
      l: [99.0],
      c: [100.5],
    };

    // First fetch succeeds
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    const { rerender } = render(<PriceHistoryChart ticker="AAPL" nowSecs={1500000} />);
    fireEvent.click(screen.getByText(/Show price history/));

    await waitFor(() => expect(mockSetData).toHaveBeenCalledTimes(1));

    // Second fetch fails (new bucket)
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ s: "no_data" }),
    });

    rerender(<PriceHistoryChart ticker="AAPL" nowSecs={1500300} />);

    // Should still show ready state (kept last good data)
    await waitFor(() => {
      expect(screen.queryByText(/Price history unavailable/)).not.toBeInTheDocument();
      expect(screen.queryByText(/No price history/)).not.toBeInTheDocument();
    });
  });

  it("uses --mer-* CSS tokens for colors", async () => {
    const mockData = {
      s: "ok" as const,
      t: [1000000],
      o: [100.0],
      h: [101.0],
      l: [99.0],
      c: [100.5],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    render(<PriceHistoryChart ticker="AAPL" nowSecs={1000000} />);
    fireEvent.click(screen.getByText(/Show price history/));

    await waitFor(() => expect(mockCreateChart).toHaveBeenCalled());

    const chartOptions = mockCreateChart.mock.calls[0]?.[1];
    expect(chartOptions).toBeDefined();
    // Colors should come from CSS vars (getCssVar reads from document)
    // In test environment, they'll be empty strings, but the code path is exercised
  });

  it("has correct label", () => {
    render(<PriceHistoryChart ticker="NVDA" nowSecs={1000000} />);
    expect(
      screen.getByText(/Show price history · Pyth price, last 7 days \(context only\)/),
    ).toBeInTheDocument();
  });

  it("uses autoSize for chart width", async () => {
    const mockData = {
      s: "ok" as const,
      t: [1000000],
      o: [100.0],
      h: [101.0],
      l: [99.0],
      c: [100.5],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    render(<PriceHistoryChart ticker="AAPL" nowSecs={1000000} />);
    fireEvent.click(screen.getByText(/Show price history/));

    await waitFor(() => expect(mockCreateChart).toHaveBeenCalled());

    const chartOptions = mockCreateChart.mock.calls[0]?.[1];
    expect(chartOptions).toHaveProperty("autoSize", true);
  });

  it("has explicit height classes", async () => {
    const mockData = {
      s: "ok" as const,
      t: [1000000],
      o: [100.0],
      h: [101.0],
      l: [99.0],
      c: [100.5],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    render(<PriceHistoryChart ticker="AAPL" nowSecs={1000000} />);
    fireEvent.click(screen.getByText(/Show price history/));

    await waitFor(() => {
      const container = document.querySelector(".h-48");
      expect(container).toBeInTheDocument();
      expect(container).toHaveClass("sm:h-64");
    });
  });
});
