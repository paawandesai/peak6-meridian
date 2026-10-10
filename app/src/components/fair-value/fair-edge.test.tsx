import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FairEdge, staleDetail } from "./fair-edge";
import { fair, NOW } from "./test-support";
import { formatEtHms } from "@/lib/time";

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

describe("FairEdge colour and stale tag (P0-FV)", () => {
  it("colours a cheap edge in the YES colour and a rich one in the NO colour, word kept", () => {
    const a = render(<FairEdge {...base} yesCents={55} fair={fair()} />);
    expect(screen.getByTestId("edge")).toHaveClass("text-mer-yes");
    expect(screen.getByTestId("edge")).toHaveTextContent("(cheap)");
    a.unmount();
    const b = render(<FairEdge {...base} yesCents={62} fair={fair()} />);
    expect(screen.getByTestId("edge")).toHaveClass("text-mer-no");
    b.unmount();
    render(<FairEdge {...base} yesCents={58} fair={fair()} />);
    expect(screen.getByTestId("edge")).toHaveClass("text-mer-ink-muted");
  });

  it("still shows a stale value and its edge, muted, with a tag giving its as-of time and age", () => {
    const asOf = new Date((NOW - 45) * 1000).toISOString();
    render(<FairEdge {...base} yesCents={62} fair={fair({ stale: true, as_of: asOf })} />);
    const line = screen.getByTestId("fair-edge");
    expect(line).toHaveTextContent("Fair 58¢ · Edge +4¢ (rich)");
    expect(line).toHaveAttribute("data-stale", "true");
    expect(line).toHaveClass("text-mer-ink-muted");
    expect(screen.getByTestId("edge")).toHaveClass("text-mer-ink-muted");
    const tag = screen.getByTestId("stale-tag");
    const detail = `Fair value as of ${formatEtHms(NOW - 45)} ET, 45 s old`;
    expect(tag).toHaveAttribute("title", detail);
    // The same words reach a screen reader, not only the hover title.
    expect(tag).toHaveTextContent(`stale: ${detail}`);
  });

  it("says the refresh failed in the tag when that is why the value is old", () => {
    render(<FairEdge {...base} refreshFailed yesCents={62} fair={fair()} />);
    expect(screen.getByTestId("stale-tag").getAttribute("title")).toMatch(
      /, 2 s old; the last refresh failed$/,
    );
  });

  it("writes the age in minutes and hours once it is that old", () => {
    expect(staleDetail(NOW - 125, NOW)).toMatch(/, 2 min old$/);
    expect(staleDetail(NOW - 7_300, NOW)).toMatch(/, 2 h old$/);
  });
});

describe("FairEdge with no value", () => {
  it("says loading when loading, returns null when unavailable (probability shown in dedicated column)", () => {
    const a = render(<FairEdge {...base} status="loading" yesCents={62} fair={undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Fair value loading…");
    a.unmount();
    const { container } = render(
      <FairEdge {...base} status="unavailable" yesCents={62} fair={undefined} />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByText(/¢/)).toBeNull();
  });
});
