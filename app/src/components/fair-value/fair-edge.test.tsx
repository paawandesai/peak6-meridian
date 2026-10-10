import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FairEdge, fairDetail, spotAsOfText } from "./fair-edge";
import { fair, NOW } from "./test-support";
import { formatEtHms } from "@/lib/time";

/** Read just now: nothing is stale unless the server says so or the test moves this back. */
const base = { status: "ready", lastSuccessSecs: NOW - 1, nowSecs: NOW } as const;
const isoAt = (secs: number): string => new Date(secs * 1000).toISOString();

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

describe("FairEdge staleness (P0-FV: from the server, not the spot age)", () => {
  it("is not labelled stale for a fresh value", () => {
    render(<FairEdge {...base} yesCents={62} fair={fair()} />);
    expect(screen.queryByTestId("stale-tag")).toBeNull();
    expect(screen.getByTestId("fair-edge")).toHaveAttribute("data-stale", "false");
  });

  it("is not stale when the spot is 20 h old but the server sends stale: false (weekend demo)", () => {
    const asOf = NOW - 20 * 3_600;
    render(<FairEdge {...base} yesCents={62} fair={fair({ as_of: isoAt(asOf) })} />);
    const line = screen.getByTestId("fair-edge");
    expect(line).toHaveAttribute("data-stale", "false");
    expect(screen.queryByTestId("stale-tag")).toBeNull();
    expect(line).not.toHaveClass("text-mer-ink-muted");
    // The spot time is still told, on hover and to screen readers (NOW is Thursday 13:20 ET).
    const spot = `Spot as of Wed ${formatEtHms(asOf)} ET`;
    expect(line).toHaveAttribute("title", spot);
    expect(screen.getByTestId("fair-spot")).toHaveTextContent(spot);
  });

  it("is labelled stale when the service flags it, saying so", () => {
    render(<FairEdge {...base} yesCents={62} fair={fair({ stale: true })} />);
    const tag = screen.getByTestId("stale-tag");
    expect(tag.getAttribute("title")).toMatch(/; the pricing service flagged it stale$/);
  });

  it("is labelled stale once no read has succeeded for over 30 s, not at 30 s", () => {
    const a = render(<FairEdge {...base} lastSuccessSecs={NOW - 30} yesCents={62} fair={fair()} />);
    expect(screen.queryByTestId("stale-tag")).toBeNull();
    a.unmount();
    render(<FairEdge {...base} lastSuccessSecs={NOW - 31} yesCents={62} fair={fair()} />);
    expect(screen.getByTestId("stale-tag").getAttribute("title")).toMatch(
      /; no update from the pricing service for 31 s$/,
    );
  });

  it("is labelled stale when no read ever succeeded", () => {
    render(<FairEdge {...base} lastSuccessSecs={null} yesCents={62} fair={fair()} />);
    expect(screen.getByTestId("stale-tag").getAttribute("title")).toMatch(
      /; no update from the pricing service yet$/,
    );
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

  it("still shows a stale value and its edge, muted, with a tag giving its spot time and why", () => {
    const asOf = NOW - 45;
    render(<FairEdge {...base} yesCents={62} fair={fair({ stale: true, as_of: isoAt(asOf) })} />);
    const line = screen.getByTestId("fair-edge");
    expect(line).toHaveTextContent("Fair 58¢ · Edge +4¢ (rich)");
    expect(line).toHaveAttribute("data-stale", "true");
    expect(line).toHaveClass("text-mer-ink-muted");
    expect(screen.getByTestId("edge")).toHaveClass("text-mer-ink-muted");
    const tag = screen.getByTestId("stale-tag");
    const detail = `Spot as of ${formatEtHms(asOf)} ET; the pricing service flagged it stale`;
    expect(tag).toHaveAttribute("title", detail);
    // The same words reach a screen reader, not only the hover title.
    expect(tag).toHaveTextContent(`stale: ${detail}`);
  });

  it("writes the no-update time in minutes and hours once it is that long", () => {
    const at = (secs: number) => fairDetail(NOW, [{ kind: "no-update", secs }], NOW);
    expect(at(125)).toMatch(/for 2 min$/);
    expect(at(7_300)).toMatch(/for 2 h$/);
  });

  it("names both reasons when both hold", () => {
    const detail = fairDetail(NOW, [{ kind: "no-update", secs: 40 }, { kind: "server" }], NOW);
    expect(detail).toBe(
      `${spotAsOfText(NOW, NOW)}; no update from the pricing service for 40 s; the pricing service flagged it stale`,
    );
  });

  it("gives the weekday for a spot from an earlier ET day", () => {
    // NOW is Thu 2026-10-08 13:20 ET; one day back is Wednesday.
    expect(spotAsOfText(NOW - 86_400, NOW)).toBe(`Spot as of Wed ${formatEtHms(NOW)} ET`);
    expect(spotAsOfText(NOW - 60, NOW)).toBe(`Spot as of ${formatEtHms(NOW - 60)} ET`);
  });
});

describe("FairEdge with no value", () => {
  it("says loading when loading, returns null when unavailable (probability shown in dedicated column)", () => {
    const a = render(<FairEdge {...base} status="loading" yesCents={62} fair={undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Fair value loading…");
    a.unmount();
    const { container } = render(
      <FairEdge
        {...base}
        status="unavailable"
        lastSuccessSecs={null}
        yesCents={62}
        fair={undefined}
      />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByText(/¢/)).toBeNull();
  });
});
