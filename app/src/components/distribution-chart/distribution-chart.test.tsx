import { render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { bucketLabel, DistributionChart } from "./distribution-chart";
import type { DistributionPoint } from "./distribution";
import { NOW } from "@/components/fair-value/test-support";

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
        nowSecs={NOW}
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

  it("labels the chart image and points to the tables", () => {
    render(<DistributionChart nowSecs={NOW} ticker="NVDA" points={[pt(170, 71, null)]} />);
    expect(
      screen.getByRole("img", {
        name: /Bar chart of the market-implied chance, in percent, that NVDA closes in each strike range, with the fair-value distribution as a line\. The tables below have the same data\./,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Implied distribution: NVDA")).toBeInTheDocument();
  });

  it("tables the chance by range for the market and the fair value (P0-FV)", () => {
    render(
      <DistributionChart
        nowSecs={NOW}
        ticker="NVDA"
        points={[pt(170, 71, 70), pt(180, 56, 58), pt(190, 31, null)]}
      />,
    );
    const rows = within(screen.getByTestId("distribution-buckets"))
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent);
    expect(rows).toEqual([
      "below $17029%30%",
      "$170 to below $18015%12%",
      "$180 to below $19025%—",
      "$190 or above31%—",
    ]);
  });

  it("colours the edge by side and keeps the word (P0-FV)", () => {
    render(
      <DistributionChart nowSecs={NOW} ticker="NVDA" points={[pt(170, 71, 70), pt(180, 56, 58)]} />,
    );
    const edges = screen.getAllByTestId("edge");
    expect(edges.map((e) => [e.textContent, e.dataset.tone])).toEqual([
      ["Edge +1¢ (rich)", "no"],
      ["Edge −2¢ (cheap)", "yes"],
    ]);
    expect(edges[0]).toHaveClass("text-mer-no");
    expect(edges[1]).toHaveClass("text-mer-yes");
  });

  it("shows a stale fair value muted with a stale tag giving its spot time and why (P0-FV)", () => {
    render(
      <DistributionChart
        nowSecs={NOW}
        ticker="NVDA"
        points={[
          {
            ...pt(170, 71, 70),
            fairStale: true,
            fairAsOfSecs: NOW - 45,
            fairStaleReasons: [{ kind: "no-update", secs: 40 }],
          },
          { ...pt(180, 56, 58), fairStale: true },
          pt(190, 31, 30),
        ]}
      />,
    );
    const tags = screen.getAllByTestId("stale-tag");
    expect(tags).toHaveLength(2);
    expect(tags[0]).toHaveAttribute(
      "title",
      expect.stringMatching(
        /^Spot as of \d\d:\d\d:\d\d ET; no update from the pricing service for 40 s$/,
      ),
    );
    expect(tags[1]).toHaveAttribute("title", "Fair value is the service's last one");
    // The stale value is still printed and its edge still computed, muted.
    const rows = within(screen.getByTestId("distribution-table")).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("70¢stale");
    expect(within(rows[1] as HTMLElement).getByTestId("edge")).toHaveClass("text-mer-ink-muted");
    expect(rows[3]).not.toHaveTextContent("stale");
    expect(screen.getByTestId("distribution-stale-note")).toHaveTextContent(
      "Fair values tagged stale are the last ones the pricing service published; each tag says why.",
    );
  });

  it("says the bars pool an inconsistent ladder", () => {
    render(
      <DistributionChart
        nowSecs={NOW}
        ticker="NVDA"
        points={[pt(170, 40, null), pt(180, 56, null)]}
      />,
    );
    expect(screen.getByTestId("distribution-corrected")).toHaveTextContent(
      "The bars pool those strikes to their average so no range is negative.",
    );
    const rows = within(screen.getByTestId("distribution-buckets"))
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent);
    expect(rows).toEqual(["below $17052%—", "$170 to below $1800%—", "$180 or above48%—"]);
  });

  it("shows a ladder inconsistency in words instead of hiding it", () => {
    render(
      <DistributionChart
        nowSecs={NOW}
        ticker="NVDA"
        points={[pt(170, 40, null), pt(180, 56, null)]}
      />,
    );
    expect(screen.getByLabelText("Ladder inconsistencies")).toHaveTextContent(
      "Ladder inconsistency: $180 YES is 56¢, above $170 YES at 40¢ (a higher strike should not cost more).",
    );
  });

  it("shows no inconsistency for a sane ladder", () => {
    render(
      <DistributionChart
        nowSecs={NOW}
        ticker="NVDA"
        points={[pt(170, 71, null), pt(180, 56, null)]}
      />,
    );
    expect(screen.queryByLabelText("Ladder inconsistencies")).toBeNull();
    expect(screen.queryByTestId("distribution-corrected")).toBeNull();
  });

  it("labels each range for the chart axis", () => {
    expect(bucketLabel({ lowerStrikeCents: null, upperStrikeCents: 17_000n })).toBe("<$170");
    expect(bucketLabel({ lowerStrikeCents: 17_000n, upperStrikeCents: 18_000n })).toBe("$170–180");
    expect(bucketLabel({ lowerStrikeCents: 19_000n, upperStrikeCents: null })).toBe("≥$190");
    expect(bucketLabel({ lowerStrikeCents: null, upperStrikeCents: null })).toBe("all");
  });

  it("renders nothing for a ticker with no strikes", () => {
    const { container } = render(<DistributionChart nowSecs={NOW} ticker="NVDA" points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
