import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TickerInsight, TickerInsightView } from "./ticker-insight";
import { fair, ladder, NOW, ready } from "./test-support";

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

const [a190, a170, a180] = ladder();
const books = {
  [a170?.address ?? ""]: ready(70, 72),
  [a180?.address ?? ""]: ready(55, 57),
  [a190?.address ?? ""]: ready(30, 33),
};

describe("TickerInsightView (the Trade page's M3-03 mount)", () => {
  it("shows the market's fair value and edge, and the ticker's distribution", () => {
    render(
      <TickerInsightView
        market={a180 as never}
        ladder={ladder()}
        books={books}
        fair={{
          status: "ready",
          refreshFailed: false,
          byMarket: {
            [a180?.address ?? ""]: fair({ market: a180?.address ?? "", fair_cents: 52 }),
          },
        }}
        nowSecs={NOW}
      />,
    );
    // mid of 55/57 = 56 → edge +4¢ against fair 52.
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Fair 52¢ · Edge +4¢ (rich)");
    expect(screen.getByText("Implied distribution: NVDA")).toBeInTheDocument();
    expect(screen.getByTestId("distribution-table")).toBeInTheDocument();
  });

  it("says the fair value is unavailable when the service has none", () => {
    render(
      <TickerInsightView
        market={a180 as never}
        ladder={ladder()}
        books={books}
        fair={{ status: "unavailable", refreshFailed: true, byMarket: {} }}
        nowSecs={NOW}
      />,
    );
    expect(screen.getByText("Fair value unavailable")).toBeInTheDocument();
  });

  it("treats an unreadable book as no price", () => {
    render(
      <TickerInsightView
        market={a180 as never}
        ladder={ladder()}
        books={{ [a180?.address ?? ""]: { state: "unavailable" } }}
        fair={{
          status: "ready",
          refreshFailed: false,
          byMarket: { [a180?.address ?? ""]: fair({ market: a180?.address ?? "" }) },
        }}
        nowSecs={NOW}
      />,
    );
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Edge unavailable");
  });
});

describe("TickerInsight (reads the proxy)", () => {
  it("fetches /api/fair-values and shows the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([fair({ market: a180?.address ?? "", fair_cents: 52 })]), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<TickerInsight market={a180 as never} ladder={ladder()} books={books} nowSecs={NOW} />);
    expect(await screen.findByText(/Fair 52¢/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/fair-values", { cache: "no-store" });
    vi.unstubAllGlobals();
  });
});
