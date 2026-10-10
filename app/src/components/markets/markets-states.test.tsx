import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  MarketsEmpty,
  MarketsLoading,
  StalePriceLabel,
  StalePriceBanner,
} from "./markets-states";

describe("MarketsEmpty", () => {
  it("displays default message", () => {
    render(<MarketsEmpty />);

    expect(
      screen.getByText(/No markets today\. Markets are created each trading day\./)
    ).toBeInTheDocument();
  });

  it("displays custom message when provided", () => {
    render(<MarketsEmpty message="No markets for AAPL today" />);

    expect(screen.getByText("No markets for AAPL today")).toBeInTheDocument();
  });
});

describe("MarketsLoading", () => {
  it("displays loading spinner", () => {
    const { container } = render(<MarketsLoading />);

    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("displays loading text", () => {
    render(<MarketsLoading />);

    expect(screen.getByText("Loading markets…")).toBeInTheDocument();
  });
});

describe("StalePriceLabel", () => {
  it("hides when price is fresh (≤10s)", () => {
    const { container } = render(<StalePriceLabel staleSecs={5} />);

    expect(container.firstChild).toBeNull();
  });

  it("shows seconds when 10s < staleSecs < 60s", () => {
    render(<StalePriceLabel staleSecs={45} />);

    expect(screen.getByText("45s old")).toBeInTheDocument();
  });

  it("shows minutes when staleSecs ≥ 60s", () => {
    render(<StalePriceLabel staleSecs={90} />);

    expect(screen.getByText("1m old")).toBeInTheDocument();
  });

  it("shows correct minutes for longer durations", () => {
    render(<StalePriceLabel staleSecs={185} />);

    expect(screen.getByText("3m old")).toBeInTheDocument();
  });

  it("shows at exactly 11s", () => {
    render(<StalePriceLabel staleSecs={11} />);

    expect(screen.getByText("11s old")).toBeInTheDocument();
  });
});

describe("StalePriceBanner", () => {
  it("hides when price is not stale (≤60s)", () => {
    const { container } = render(<StalePriceBanner staleSecs={30} />);

    expect(container.firstChild).toBeNull();
  });

  it("shows warning when staleSecs > 60s", () => {
    render(<StalePriceBanner staleSecs={90} />);

    expect(screen.getByText(/Prices may be outdated/)).toBeInTheDocument();
  });

  it("shows singular minute for 60s-119s", () => {
    render(<StalePriceBanner staleSecs={90} />);

    expect(screen.getByText(/1 minute ago/)).toBeInTheDocument();
  });

  it("shows plural minutes for ≥120s", () => {
    render(<StalePriceBanner staleSecs={180} />);

    expect(screen.getByText(/3 minutes ago/)).toBeInTheDocument();
  });

  it("displays warning icon", () => {
    const { container } = render(<StalePriceBanner staleSecs={90} />);

    const icon = container.querySelector("svg");
    expect(icon).toBeInTheDocument();
  });
});
