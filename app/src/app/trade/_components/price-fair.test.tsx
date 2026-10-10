import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FAIR_UNAVAILABLE_TEXT, NO_TIGHT_PRICE_TEXT, PriceFair } from "./price-fair";
import { fair, NOW } from "@/components/fair-value/test-support";
import type { FairValues } from "@/lib/fair-values";

const ADDR = "Mkt1111111111111111111111111111111111111111";
const ready = (fairCents: number): FairValues => ({
  status: "ready",
  byMarket: { [ADDR]: fair({ fair_cents: fairCents }) },
  lastSuccessSecs: NOW - 1,
});

describe("PriceFair (P0-7 AC3, US-15)", () => {
  it("shows the price, its probability and NO = 100 − YES, then fair and edge in words", () => {
    render(<PriceFair marketAddress={ADDR} yesCents={38} fair={ready(41)} nowSecs={NOW} />);
    expect(screen.getByTestId("displayed-price")).toHaveTextContent("YES 38¢ · 38% · NO 62¢");
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Fair 41¢ · Edge −3¢ (cheap)");
  });

  it("labels a rich price as rich", () => {
    render(<PriceFair marketAddress={ADDR} yesCents={62} fair={ready(58)} nowSecs={NOW} />);
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Edge +4¢ (rich)");
  });

  it("says when there is no tight price instead of inventing one", () => {
    render(<PriceFair marketAddress={ADDR} yesCents={null} fair={ready(58)} nowSecs={NOW} />);
    expect(screen.getByTestId("displayed-price")).toHaveTextContent(NO_TIGHT_PRICE_TEXT);
    expect(screen.getByTestId("fair-edge")).toHaveTextContent(
      "Fair 58¢ · Edge unavailable (no tight market price)",
    );
  });

  it("says fair value is unavailable in words when the service has none", () => {
    render(
      <PriceFair
        marketAddress={ADDR}
        yesCents={50}
        fair={{ status: "unavailable", byMarket: {}, lastSuccessSecs: null }}
        nowSecs={NOW}
      />,
    );
    expect(screen.getByTestId("fair-edge-missing")).toHaveTextContent(FAIR_UNAVAILABLE_TEXT);
    // A ready response that lacks this strike says the same.
    render(<PriceFair marketAddress="Other" yesCents={50} fair={ready(41)} nowSecs={NOW} />);
    expect(screen.getAllByTestId("fair-edge-missing")).toHaveLength(2);
  });

  it("shows a stale value with a stale tag, never as unavailable (P0-FV)", () => {
    const old = new Date((NOW - 40) * 1000).toISOString();
    render(
      <PriceFair
        marketAddress={ADDR}
        yesCents={38}
        fair={{
          status: "ready",
          byMarket: { [ADDR]: fair({ fair_cents: 41, stale: true, as_of: old }) },
          lastSuccessSecs: NOW - 1,
        }}
        nowSecs={NOW}
      />,
    );
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Fair 41¢ · Edge −3¢ (cheap)");
    expect(screen.getByTestId("stale-tag")).toHaveAttribute(
      "title",
      expect.stringContaining("the pricing service flagged it stale"),
    );
    expect(screen.queryByTestId("fair-edge-missing")).toBeNull();
  });

  it("keeps the last values, tagged stale, after 30 s with no successful read (P0-FV)", () => {
    render(
      <PriceFair
        marketAddress={ADDR}
        yesCents={38}
        fair={{ ...ready(41), lastSuccessSecs: NOW - 31 }}
        nowSecs={NOW}
      />,
    );
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Fair 41¢");
    expect(screen.getByTestId("stale-tag")).toHaveAttribute(
      "title",
      expect.stringContaining("no update from the pricing service for 31 s"),
    );
    expect(screen.queryByTestId("fair-edge-missing")).toBeNull();
  });

  it("says loading while the first read is in flight", () => {
    render(
      <PriceFair
        marketAddress={ADDR}
        yesCents={50}
        fair={{ status: "loading", byMarket: {}, lastSuccessSecs: null }}
        nowSecs={NOW}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Fair value loading…");
  });
});
