import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MMExposureBlock } from "./mm-exposure-block";

describe("MMExposureBlock", () => {
  it("renders nothing when no open orders", () => {
    const { container } = render(
      <MMExposureBlock strikeExposures={[]} openOrdersCount={0} unsettledBalanceBase={0n} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("displays open orders count (singular)", () => {
    render(
      <MMExposureBlock
        strikeExposures={[]}
        openOrdersCount={1}
        unsettledBalanceBase={10_000_000n}
      />
    );

    expect(screen.getByText(/1 open order/)).toBeInTheDocument();
  });

  it("displays open orders count (plural)", () => {
    render(
      <MMExposureBlock
        strikeExposures={[]}
        openOrdersCount={5}
        unsettledBalanceBase={10_000_000n}
      />
    );

    expect(screen.getByText(/5 open orders/)).toBeInTheDocument();
  });

  it("displays unsettled balance using formatUsdSigned", () => {
    // 10 USDC = 10_000_000 base units
    render(
      <MMExposureBlock
        strikeExposures={[]}
        openOrdersCount={1}
        unsettledBalanceBase={10_000_000n}
      />
    );

    expect(screen.getByText(/\$10\.00 unsettled/)).toBeInTheDocument();
  });

  it("is expanded by default when has open orders", () => {
    const { container } = render(
      <MMExposureBlock
        strikeExposures={[]}
        openOrdersCount={1}
        unsettledBalanceBase={10_000_000n}
      />
    );

    const details = container.querySelector("details");
    expect(details).toHaveAttribute("open");
  });

  it("can be collapsed and expanded", () => {
    const { container } = render(
      <MMExposureBlock
        strikeExposures={[]}
        openOrdersCount={1}
        unsettledBalanceBase={10_000_000n}
      />
    );

    const summary = screen.getByText(/MM Exposure/);
    const details = container.querySelector("details");

    // Initially open
    expect(details).toHaveAttribute("open");

    // Collapse
    fireEvent.click(summary);
    expect(details).not.toHaveAttribute("open");

    // Re-expand
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
  });

  it("displays strike exposures in table", () => {
    const strikeExposures = [
      { strikeCents: 18000n, netContracts: 50, marketAddress: "market1" },
      { strikeCents: 19000n, netContracts: -30, marketAddress: "market2" },
    ];

    render(
      <MMExposureBlock
        strikeExposures={strikeExposures}
        openOrdersCount={2}
        unsettledBalanceBase={10_000_000n}
      />
    );

    expect(screen.getByText("$180")).toBeInTheDocument();
    expect(screen.getByText("$190")).toBeInTheDocument();
  });

  it("displays positive net exposure with + prefix and gain color", () => {
    const strikeExposures = [
      { strikeCents: 18000n, netContracts: 50, marketAddress: "market1" },
    ];

    render(
      <MMExposureBlock
        strikeExposures={strikeExposures}
        openOrdersCount={1}
        unsettledBalanceBase={10_000_000n}
      />
    );

    const netCell = screen.getByText("+50");
    expect(netCell).toHaveClass("text-mer-gain");
  });

  it("displays negative net exposure with - prefix and loss color", () => {
    const strikeExposures = [
      { strikeCents: 18000n, netContracts: -30, marketAddress: "market1" },
    ];

    render(
      <MMExposureBlock
        strikeExposures={strikeExposures}
        openOrdersCount={1}
        unsettledBalanceBase={10_000_000n}
      />
    );

    const netCell = screen.getByText("-30");
    expect(netCell).toHaveClass("text-mer-loss");
  });

  it("displays zero net exposure with muted color", () => {
    const strikeExposures = [
      { strikeCents: 18000n, netContracts: 0, marketAddress: "market1" },
    ];

    render(
      <MMExposureBlock
        strikeExposures={strikeExposures}
        openOrdersCount={1}
        unsettledBalanceBase={10_000_000n}
      />
    );

    const netCell = screen.getByText("0");
    expect(netCell).toHaveClass("text-mer-ink-muted");
  });

  it("shows 'No net exposure' when exposures array is empty", () => {
    render(
      <MMExposureBlock
        strikeExposures={[]}
        openOrdersCount={1}
        unsettledBalanceBase={10_000_000n}
      />
    );

    expect(screen.getByText("No net exposure")).toBeInTheDocument();
  });

  it("renders table headers", () => {
    const strikeExposures = [
      { strikeCents: 18000n, netContracts: 50, marketAddress: "market1" },
    ];

    render(
      <MMExposureBlock
        strikeExposures={strikeExposures}
        openOrdersCount={1}
        unsettledBalanceBase={10_000_000n}
      />
    );

    expect(screen.getByText("Strike")).toBeInTheDocument();
    expect(screen.getByText("Net")).toBeInTheDocument();
  });

  it("uses monospace font for net contracts", () => {
    const strikeExposures = [
      { strikeCents: 18000n, netContracts: 50, marketAddress: "market1" },
    ];

    render(
      <MMExposureBlock
        strikeExposures={strikeExposures}
        openOrdersCount={1}
        unsettledBalanceBase={10_000_000n}
      />
    );

    const netCell = screen.getByText("+50");
    expect(netCell).toHaveClass("font-mer-mono");
  });

  it("handles multiple strikes correctly", () => {
    const strikeExposures = [
      { strikeCents: 18000n, netContracts: 50, marketAddress: "market1" },
      { strikeCents: 19000n, netContracts: -30, marketAddress: "market2" },
      { strikeCents: 20000n, netContracts: 0, marketAddress: "market3" },
    ];

    render(
      <MMExposureBlock
        strikeExposures={strikeExposures}
        openOrdersCount={3}
        unsettledBalanceBase={50_000_000n}
      />
    );

    expect(screen.getByText("$180")).toBeInTheDocument();
    expect(screen.getByText("$190")).toBeInTheDocument();
    expect(screen.getByText("$200")).toBeInTheDocument();
    expect(screen.getByText("+50")).toBeInTheDocument();
    expect(screen.getByText("-30")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
