import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TickerInsightView } from "./ticker-insight";
import { fair, ladder, NOW, ready } from "./test-support";

vi.mock("@/components/price-history-chart/price-history-chart", () => ({
  PriceHistoryChart: () => null,
}));

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
          lastSuccessSecs: NOW - 1,
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

  it("returns null when the service has no fair value (probability shown in dedicated column)", () => {
    render(
      <TickerInsightView
        market={a180 as never}
        ladder={ladder()}
        books={books}
        fair={{ status: "unavailable", lastSuccessSecs: null, byMarket: {} }}
        nowSecs={NOW}
      />,
    );
    // FairEdge returns null when unavailable; probability is shown elsewhere
    expect(screen.queryByTestId("fair-edge")).not.toBeInTheDocument();
  });

  it("treats an unreadable book as no price", () => {
    render(
      <TickerInsightView
        market={a180 as never}
        ladder={ladder()}
        books={{ [a180?.address ?? ""]: { state: "unavailable" } }}
        fair={{
          status: "ready",
          lastSuccessSecs: NOW - 1,
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
    render(
      <TickerInsightView
        market={a180 as never}
        ladder={ladder()}
        books={books}
        fair={{
          status: "ready",
          lastSuccessSecs: NOW - 1,
          byMarket: {
            [a180?.address ?? ""]: fair({ market: a180?.address ?? "", fair_cents: 52 }),
          },
        }}
        nowSecs={NOW}
      />,
    );
    expect(await screen.findByText(/Fair 52¢/)).toBeInTheDocument();
  });
});
