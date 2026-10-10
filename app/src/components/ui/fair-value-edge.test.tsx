import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { FairValueEdge } from "./fair-value-edge";

describe("FairValueEdge", () => {
  it("shows fair value and positive edge (rich)", () => {
    // Market 62¢, fair 58¢ → edge +4¢ (rich)
    render(<FairValueEdge marketPriceCents={62} fairValueCents={58} />);

    expect(screen.getByTestId("fair-value-edge")).toHaveTextContent("Fair 58¢");
    expect(screen.getByTestId("fair-value-edge")).toHaveTextContent("Edge +4¢ (rich)");
  });

  it("shows fair value and negative edge (cheap)", () => {
    // Market 38¢, fair 41¢ → edge −3¢ (cheap)
    render(<FairValueEdge marketPriceCents={38} fairValueCents={41} />);

    expect(screen.getByTestId("fair-value-edge")).toHaveTextContent("Fair 41¢");
    expect(screen.getByTestId("fair-value-edge")).toHaveTextContent("Edge -3¢ (cheap)");
  });

  it("shows zero edge as (fair)", () => {
    // Market 50¢, fair 50¢ → edge 0¢ (fair)
    render(<FairValueEdge marketPriceCents={50} fairValueCents={50} />);

    expect(screen.getByTestId("fair-value-edge")).toHaveTextContent("Fair 50¢");
    expect(screen.getByTestId("fair-value-edge")).toHaveTextContent("Edge 0¢ (fair)");
  });

  it("returns null when fair value is not available", () => {
    const { container } = render(<FairValueEdge marketPriceCents={50} fairValueCents={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when market price is not available", () => {
    const { container } = render(<FairValueEdge marketPriceCents={null} fairValueCents={50} />);
    expect(container.firstChild).toBeNull();
  });

  it("handles edge cases: 1¢ market, 99¢ fair", () => {
    // Market 1¢, fair 99¢ → edge −98¢ (cheap)
    render(<FairValueEdge marketPriceCents={1} fairValueCents={99} />);

    expect(screen.getByTestId("fair-value-edge")).toHaveTextContent("Fair 99¢");
    expect(screen.getByTestId("fair-value-edge")).toHaveTextContent("Edge -98¢ (cheap)");
  });

  it("handles edge cases: 99¢ market, 1¢ fair", () => {
    // Market 99¢, fair 1¢ → edge +98¢ (rich)
    render(<FairValueEdge marketPriceCents={99} fairValueCents={1} />);

    expect(screen.getByTestId("fair-value-edge")).toHaveTextContent("Fair 1¢");
    expect(screen.getByTestId("fair-value-edge")).toHaveTextContent("Edge +98¢ (rich)");
  });
});
