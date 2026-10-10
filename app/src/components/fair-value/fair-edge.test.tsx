import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FairEdge } from "./fair-edge";
import { fair, NOW } from "./test-support";

const base = { status: "ready", refreshFailed: false, nowSecs: NOW } as const;

describe("FairEdge (M3-03 AC1)", () => {
  it("rich: `Fair 58¢ · Edge +4¢ (rich)`", () => {
    render(<FairEdge {...base} yesCents={62} fair={fair()} />);
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Fair 58¢ · Edge +4¢ (rich)");
  });

  it("cheap: `Edge −3¢ (cheap)`", () => {
    render(<FairEdge {...base} yesCents={55} fair={fair()} />);
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Fair 58¢ · Edge −3¢ (cheap)");
  });

  it("zero: the word is still written", () => {
    render(<FairEdge {...base} yesCents={58} fair={fair()} />);
    expect(screen.getByTestId("fair-edge")).toHaveTextContent("Fair 58¢ · Edge 0¢ (fair)");
  });

  it("says there is no edge when the book gives no tight price", () => {
    render(<FairEdge {...base} yesCents={null} fair={fair()} />);
    expect(screen.getByTestId("fair-edge")).toHaveTextContent(
      "Fair 58¢ · Edge unavailable (no tight market price)",
    );
  });
});

describe("FairEdge staleness (M3-03 AC2)", () => {
  it("is not labelled stale for a fresh value", () => {
    render(<FairEdge {...base} yesCents={62} fair={fair()} />);
    expect(screen.queryByText(/stale/)).toBeNull();
  });

  it("is labelled stale when the service flags it, the value is old, or the refresh failed", () => {
    const old = new Date((NOW - 30) * 1000).toISOString();
    const a = render(<FairEdge {...base} yesCents={62} fair={fair({ stale: true })} />);
    expect(screen.getByText(/stale/)).toBeInTheDocument();
    a.unmount();
    const b = render(<FairEdge {...base} yesCents={62} fair={fair({ as_of: old })} />);
    expect(screen.getByText(/stale/)).toBeInTheDocument();
    b.unmount();
    render(<FairEdge {...base} refreshFailed yesCents={62} fair={fair()} />);
    expect(screen.getByText(/stale/)).toBeInTheDocument();
  });
});

describe("FairEdge with no value", () => {
  it("says loading when loading, returns null when unavailable (probability shown in dedicated column)", () => {
    const a = render(<FairEdge {...base} status="loading" yesCents={62} fair={undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Fair value loading…");
    a.unmount();
    const { container } = render(<FairEdge {...base} status="unavailable" yesCents={62} fair={undefined} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByText(/¢/)).toBeNull();
  });
});
