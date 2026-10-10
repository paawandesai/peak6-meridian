/**
 * P1-1: Settings sheet tests.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsSheet } from "./settings-sheet";

const originalEnv = process.env;

describe("SettingsSheet (P1-1)", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is hidden on localnet (devnet-only feature)", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "localnet";
    process.env.NEXT_PUBLIC_DEMO_MODE = "live";

    render(<SettingsSheet />);
    expect(screen.queryByLabelText("Settings")).toBeNull();
  });

  it("is hidden on mainnet", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "mainnet";
    process.env.NEXT_PUBLIC_DEMO_MODE = "live";

    render(<SettingsSheet />);
    expect(screen.queryByLabelText("Settings")).toBeNull();
  });

  it("shows settings button on devnet", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "devnet";
    process.env.NEXT_PUBLIC_DEMO_MODE = "live";

    render(<SettingsSheet />);
    expect(screen.getByLabelText("Settings")).toBeInTheDocument();
  });

  it("shows Live (Pyth) mode when DEMO_MODE is live", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "devnet";
    process.env.NEXT_PUBLIC_DEMO_MODE = "live";

    render(<SettingsSheet />);
    const button = screen.getByLabelText("Settings");
    fireEvent.click(button);

    expect(screen.getByText("Live (Pyth)")).toBeInTheDocument();
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByText(/Live market data from Pyth Pro/)).toBeInTheDocument();
  });

  it("shows Replay mode with date when DEMO_MODE is replay", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "devnet";
    process.env.NEXT_PUBLIC_DEMO_MODE = "replay";
    process.env.NEXT_PUBLIC_DEMO_REPLAY_DATE = "2024-10-08";

    render(<SettingsSheet />);
    const button = screen.getByLabelText("Settings");
    fireEvent.click(button);

    expect(screen.getByText("Replay: 2024-10-08")).toBeInTheDocument();
    expect(screen.getByText("REPLAY")).toBeInTheDocument();
    expect(screen.getByText(/Replaying historical trading day 2024-10-08/)).toBeInTheDocument();
  });

  it("opens and closes the sheet", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "devnet";
    process.env.NEXT_PUBLIC_DEMO_MODE = "live";

    render(<SettingsSheet />);

    // Initially closed
    expect(screen.queryByText("Demo Mode")).toBeNull();

    // Open
    const button = screen.getByLabelText("Settings");
    fireEvent.click(button);
    expect(screen.getByText("Demo Mode")).toBeInTheDocument();

    // Close via X button
    const closeButton = screen.getByLabelText("Close");
    fireEvent.click(closeButton);
    expect(screen.queryByText("Demo Mode")).toBeNull();
  });

  it("closes when clicking overlay", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "devnet";
    process.env.NEXT_PUBLIC_DEMO_MODE = "live";

    const { container } = render(<SettingsSheet />);

    const button = screen.getByLabelText("Settings");
    fireEvent.click(button);
    expect(screen.getByText("Demo Mode")).toBeInTheDocument();

    // Click overlay (the fixed inset div with bg-black/50)
    const overlay = container.querySelector(".fixed.inset-0");
    if (overlay) {
      fireEvent.click(overlay);
      expect(screen.queryByText("Demo Mode")).toBeNull();
    }
  });

  it("shows note about deployment-time configuration", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "devnet";
    process.env.NEXT_PUBLIC_DEMO_MODE = "live";

    render(<SettingsSheet />);
    const button = screen.getByLabelText("Settings");
    fireEvent.click(button);

    expect(
      screen.getByText(/Demo mode is configured at deployment time/)
    ).toBeInTheDocument();
  });
});
