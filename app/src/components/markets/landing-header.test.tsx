import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockSetVisible = vi.fn();
const wallet = vi.hoisted(() => ({ publicKey: null as unknown }));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => wallet,
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  useWalletModal: () => ({ setVisible: mockSetVisible }),
}));

import { LandingHeader } from "./landing-header";

describe("LandingHeader", () => {
  beforeEach(() => {
    wallet.publicKey = null;
    mockSetVisible.mockClear();
  });

  it("renders FR-21 copy", () => {
    render(<LandingHeader />);

    expect(
      screen.getByText(/Will META close at or above \$680 at today's 4:00 PM ET close\?/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Buy YES or NO/)).toBeInTheDocument();
    expect(
      screen.getByText(/The winning side pays \$1\.00 per contract/)
    ).toBeInTheDocument();
  });

  it("renders connect CTA copy from design.md", () => {
    render(<LandingHeader />);

    expect(
      screen.getByText(/Connecting costs nothing and moves no funds/)
    ).toBeInTheDocument();
    expect(screen.getByText(/each trade asks for one signature/)).toBeInTheDocument();
  });

  it("renders Connect wallet button when wallet not connected", () => {
    render(<LandingHeader />);

    expect(screen.getByRole("button", { name: /Connect wallet/i })).toBeInTheDocument();
  });

  it("opens wallet modal when Connect button clicked", () => {
    render(<LandingHeader />);

    const connectButton = screen.getByRole("button", { name: /Connect wallet/i });
    fireEvent.click(connectButton);

    expect(mockSetVisible).toHaveBeenCalledWith(true);
  });

  it("renders demo wallet button when provided", () => {
    render(<LandingHeader demoWalletButton={<button>Try the demo wallet</button>} />);

    expect(screen.getByRole("button", { name: /Try the demo wallet/ })).toBeInTheDocument();
  });

  it("hides when wallet is connected (FR-21, UI-03 AC7)", () => {
    wallet.publicKey = { toBase58: () => "FakeWalletAddress" };

    render(<LandingHeader />);

    expect(screen.queryByText(/Will META close/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect wallet/i })).not.toBeInTheDocument();
  });
});
