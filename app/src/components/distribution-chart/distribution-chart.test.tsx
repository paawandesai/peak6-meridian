import { render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { DistributionChart } from "./distribution-chart";
import type { DistributionPoint } from "./distribution";

beforeAll(() => {
  // Recharts warns that jsdom gives the container no size; the table is what these tests read.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // jsdom has no layout; Recharts' ResponsiveContainer needs a ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

const pt = (strike: number, yes: number | null, fair: number | null): DistributionPoint => ({
  market: `m${strike}`,
  strikeCents: BigInt(strike * 100),
  yesCents: yes,
  fairCents: fair,
});

describe("DistributionChart (M3-03 AC3, AC5)", () => {
  it("has a text alternative carrying every number, in strike order", () => {
    render(
      <DistributionChart
        ticker="NVDA"
        points={[pt(170, 71, 70), pt(180, 56, 58), pt(190, 31, null)]}
      />,
    );
    const table = screen.getByTestId("distribution-table");
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent);
    expect(rows).toEqual(["$17071¢70¢Edge +1¢ (rich)", "$18056¢58¢Edge −2¢ (cheap)", "$19031¢——"]);
  });

  it("labels the chart image and points to the table", () => {
    render(<DistributionChart ticker="NVDA" points={[pt(170, 71, null)]} />);
    expect(
      screen.getByRole("img", {
        name: /Line chart of the YES price in cents by strike for NVDA\. The table below has the same data\./,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Implied distribution: NVDA")).toBeInTheDocument();
  });

  it("shows a ladder inconsistency in words instead of hiding it", () => {
    render(<DistributionChart ticker="NVDA" points={[pt(170, 40, null), pt(180, 56, null)]} />);
    expect(screen.getByLabelText("Ladder inconsistencies")).toHaveTextContent(
      "Ladder inconsistency: $180 YES is 56¢, above $170 YES at 40¢ (a higher strike should not cost more).",
    );
  });

  it("shows no inconsistency for a sane ladder", () => {
    render(<DistributionChart ticker="NVDA" points={[pt(170, 71, null), pt(180, 56, null)]} />);
    expect(screen.queryByLabelText("Ladder inconsistencies")).toBeNull();
  });

  it("renders nothing for a ticker with no strikes", () => {
    const { container } = render(<DistributionChart ticker="NVDA" points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
