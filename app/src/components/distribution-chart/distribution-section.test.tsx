import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DESKTOP_QUERY, DistributionSection, emptyDistributionText } from "./distribution-section";
import type { DistributionPoint } from "./distribution";

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

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

function viewport(desktop: boolean): void {
  window.matchMedia = vi.fn((query: string) => ({
    matches: desktop && query === DESKTOP_QUERY,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const pt = (strike: number, yes: number | null, fair: number | null = null): DistributionPoint => ({
  market: `m${strike}`,
  strikeCents: BigInt(strike * 100),
  yesCents: yes,
  fairCents: fair,
});

describe("DistributionSection (P0-7 AC4, FR-26)", () => {
  it("is open on desktop and renders the chart with its table", async () => {
    viewport(true);
    render(<DistributionSection ticker="NVDA" points={[pt(170, 71, 70), pt(180, 56, 58)]} />);
    expect(await screen.findByTestId("distribution-table")).toBeInTheDocument();
    expect(screen.getByTestId("distribution-section")).toHaveAttribute("open");
    expect(
      screen.getByText("Implied distribution: NVDA", { selector: "figcaption" }),
    ).toBeVisible();
  });

  it("is collapsed on mobile until opened", async () => {
    viewport(false);
    render(<DistributionSection ticker="NVDA" points={[pt(170, 71), pt(180, 56)]} />);
    const section = screen.getByTestId("distribution-section");
    expect(section).not.toHaveAttribute("open");
    expect(screen.queryByTestId("distribution-table")).toBeNull();
    (section as HTMLDetailsElement).open = true;
    fireEvent(section, new Event("toggle"));
    expect(await screen.findByTestId("distribution-table")).toBeInTheDocument();
  });

  it("shows explicit empty text when no strike has a displayed price", async () => {
    viewport(true);
    render(<DistributionSection ticker="NVDA" points={[pt(170, null, 70), pt(180, null)]} />);
    expect(await screen.findByTestId("distribution-empty")).toHaveTextContent(
      emptyDistributionText("NVDA"),
    );
    expect(screen.queryByTestId("distribution-table")).toBeNull();
  });

  it("shows the empty text for an empty ladder too", async () => {
    viewport(true);
    render(<DistributionSection ticker="AAPL" points={[]} />);
    expect(await screen.findByTestId("distribution-empty")).toHaveTextContent(
      "No market-implied distribution yet: no AAPL strike has a two-sided book within 10¢.",
    );
  });
});
