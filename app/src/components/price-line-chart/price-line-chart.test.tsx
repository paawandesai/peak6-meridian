import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { latestCloseText, PriceLineChart } from "./price-line-chart";
import { formatEtHm } from "@/lib/time";

const createChart = vi.fn();
const addLineSeries = vi.fn();
const setData = vi.fn();
const createPriceLine = vi.fn();
const removePriceLine = vi.fn();
const remove = vi.fn();
const fitContent = vi.fn();

vi.mock("lightweight-charts", () => ({
  createChart: (...args: unknown[]) => {
    createChart(...args);
    return { addLineSeries, remove, timeScale: () => ({ fitContent }) };
  },
}));

/** 2026-10-08 14:52:03 ET. */
const NOW = 1_791_485_523;
const BUCKET = 1_791_485_400;
const STRIKES = [17_000n, 18_000n, 19_000n];

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

const okJson = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const OK = { s: "ok", t: [BUCKET - 600, BUCKET - 300], c: [180.1, 181.42] };

const params = (call: number) => {
  const url = String(fetchMock.mock.calls[call]?.[0]);
  return new URL(url, "http://localhost").searchParams;
};

const chart = (props: Partial<Parameters<typeof PriceLineChart>[0]> = {}) => (
  <PriceLineChart
    ticker="NVDA"
    nowSecs={NOW}
    strikes={STRIKES}
    selectedStrikeCents={18_000n}
    {...props}
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  addLineSeries.mockReturnValue({ setData, createPriceLine, removePriceLine });
  createPriceLine.mockImplementation((options: { price: number }) => ({ id: options.price }));
  fetchMock = vi.fn(() => okJson(OK));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PriceLineChart: query and ranges", () => {
  it("fetches the last day of 5-minute candles for the ticker, ending at the 5-minute bucket", async () => {
    render(chart());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const p = params(0);
    expect(p.get("symbol")).toBe("Equity.US.NVDA/USD");
    expect(p.get("resolution")).toBe("5");
    expect(p.get("to")).toBe(String(BUCKET));
    expect(p.get("from")).toBe(String(BUCKET - 86_400));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("switches to a week of hourly candles with the 1W button", async () => {
    render(chart());
    await screen.findByText(/at .* ET/);
    expect(screen.getByRole("button", { name: "1D" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Price history range" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1W" }));
    expect(screen.getByRole("button", { name: "1W" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1D" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(params(1).get("resolution")).toBe("60");
    expect(Number(params(1).get("to")) - Number(params(1).get("from"))).toBe(604_800);
    expect(screen.getByRole("figure", { name: /NVDA price, last week/ })).toBeInTheDocument();
  });

  it("fetches at most once per 5-minute bucket and again when the bucket changes", async () => {
    const { rerender } = render(chart());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(chart({ nowSecs: BUCKET + 1 }));
    rerender(chart({ nowSecs: BUCKET + 299 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(chart({ nowSecs: BUCKET + 300 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(params(1).get("to")).toBe(String(BUCKET + 300));
  });
});

describe("PriceLineChart: drawing", () => {
  it("creates the chart once, draws closes in dollars from cents, and removes it on unmount", async () => {
    const { rerender, unmount } = render(chart());
    await waitFor(() => expect(setData).toHaveBeenCalled());
    expect(setData).toHaveBeenLastCalledWith([
      { time: BUCKET - 600, value: 180.1 },
      { time: BUCKET - 300, value: 181.42 },
    ]);
    expect(fitContent).toHaveBeenCalled();
    rerender(chart({ nowSecs: NOW + 1 }));
    rerender(chart({ nowSecs: NOW + 2 }));
    expect(createChart).toHaveBeenCalledTimes(1);
    expect(addLineSeries).toHaveBeenCalledTimes(1);
    unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("draws one line per strike: the selected one solid and labelled, the rest dashed; no fair line", async () => {
    render(chart());
    await waitFor(() => expect(createPriceLine).toHaveBeenCalledTimes(3));
    const calls = createPriceLine.mock.calls.map(
      ([options]) => options as { price: number; lineStyle: number; title: string },
    );
    expect(calls.map((c) => c.price)).toEqual([170, 180, 190]);
    const selected = calls.find((c) => c.price === 180);
    expect(selected).toMatchObject({ lineStyle: 0, title: "$180", axisLabelVisible: true });
    expect(
      calls.filter((c) => c.price !== 180).every((c) => c.lineStyle === 2 && c.title === ""),
    ).toBe(true);
    expect(calls.some((c) => /fair/i.test(c.title))).toBe(false);
  });

  it("redraws the strike lines when the selection changes, not when the array is recreated", async () => {
    const { rerender } = render(chart());
    await waitFor(() => expect(createPriceLine).toHaveBeenCalledTimes(3));
    rerender(chart({ strikes: [...STRIKES] }));
    expect(createPriceLine).toHaveBeenCalledTimes(3);
    rerender(chart({ selectedStrikeCents: 19_000n }));
    expect(removePriceLine).toHaveBeenCalledTimes(3);
    expect(createPriceLine).toHaveBeenCalledTimes(6);
    expect(createPriceLine).toHaveBeenLastCalledWith(
      expect.objectContaining({ price: 190, title: "$190", lineStyle: 0 }),
    );
  });

  it("names the figure by ticker and range and gives the latest close as text", async () => {
    render(chart());
    const text = `$181.42 at ${formatEtHm(BUCKET - 300)} ET`;
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: /NVDA price, last day/ })).toBeInTheDocument();
    expect(screen.getByTestId("price-line-canvas")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("PriceLineChart: states in words", () => {
  it("says it is loading until the first answer", () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    render(chart());
    expect(screen.getByRole("status")).toHaveTextContent("Loading price history…");
    expect(screen.getByTestId("price-line-canvas")).toHaveStyle({ display: "none" });
  });

  it.each([
    ["no_data", { s: "no_data" }],
    ["empty arrays", { s: "ok", t: [], c: [] }],
    ["mismatched arrays", { s: "ok", t: [1, 2], c: [1] }],
  ])("says there is no history for %s", async (_label, body) => {
    fetchMock.mockReturnValue(okJson(body));
    render(chart());
    expect(await screen.findByText("No price history from Pyth right now.")).toBeInTheDocument();
    expect(setData).not.toHaveBeenCalled();
  });

  it("says history is unavailable on an HTTP error", async () => {
    fetchMock.mockReturnValue(Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    render(chart());
    expect(await screen.findByText("Price history unavailable.")).toBeInTheDocument();
  });

  it("says history is unavailable on a body that fails the schema", async () => {
    fetchMock.mockReturnValue(okJson({ s: "ok", t: ["x"], c: [1] }));
    render(chart());
    expect(await screen.findByText("Price history unavailable.")).toBeInTheDocument();
  });

  it("says history is unavailable when the request fails", async () => {
    fetchMock.mockReturnValue(Promise.reject(new TypeError("network")));
    render(chart());
    expect(await screen.findByText("Price history unavailable.")).toBeInTheDocument();
  });

  it("keeps the last good series through a failed or empty refetch", async () => {
    const { rerender } = render(chart());
    await screen.findByText(/\$181\.42 at/);
    expect(setData).toHaveBeenCalledTimes(1);
    fetchMock.mockReturnValue(Promise.reject(new TypeError("network")));
    rerender(chart({ nowSecs: BUCKET + 300 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    fetchMock.mockReturnValue(okJson({ s: "no_data" }));
    rerender(chart({ nowSecs: BUCKET + 600 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => undefined);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText(/\$181\.42 at/)).toBeInTheDocument();
    expect(screen.getByTestId("price-line-canvas")).toHaveStyle({ display: "block" });
    expect(setData).toHaveBeenCalledTimes(1);
  });

  it("does not show one range's series under the other range's caption", async () => {
    render(chart());
    await screen.findByText(/\$181\.42 at/);
    fetchMock.mockReturnValue(new Promise(() => undefined));
    fireEvent.click(screen.getByRole("button", { name: "1W" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading price history…");
    expect(screen.queryByText(/\$181\.42 at/)).not.toBeInTheDocument();
    // Back to 1D: its last good series is still there.
    fireEvent.click(screen.getByRole("button", { name: "1D" }));
    expect(screen.getByText(/\$181\.42 at/)).toBeInTheDocument();
  });

  it("aborts the request on unmount and ignores its late answer", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = render(chart());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    unmount();
    expect(init.signal?.aborted).toBe(true);
    await act(async () => {
      resolve({ ok: true, json: () => Promise.resolve(OK) });
    });
    expect(setData).not.toHaveBeenCalled();
  });
});

describe("latestCloseText", () => {
  it("gives the time alone today and adds the weekday for an earlier day", () => {
    expect(latestCloseText({ timeSecs: BUCKET, closeCents: 18_142 }, NOW)).toBe(
      `$181.42 at ${formatEtHm(BUCKET)} ET`,
    );
    // Two days earlier, 14:50 ET.
    expect(latestCloseText({ timeSecs: BUCKET - 2 * 86_400, closeCents: 18_000 }, NOW)).toMatch(
      /^\$180\.00 at [A-Z][a-z]{2} \d\d:\d\d:\d\d ET$/,
    );
  });
});
