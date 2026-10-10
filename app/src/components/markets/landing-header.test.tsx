import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LandingHeader } from "./landing-header";

describe("LandingHeader", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
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

  it("renders demo wallet button when provided", () => {
    render(
      <LandingHeader demoWalletButton={<button>Try the demo wallet</button>} />
    );

    expect(screen.getByRole("button", { name: /Try the demo wallet/ })).toBeInTheDocument();
  });

  it("shows dismiss button", () => {
    render(<LandingHeader />);

    expect(screen.getByRole("button", { name: /Dismiss landing header/ })).toBeInTheDocument();
  });

  it("dismisses when X button clicked", () => {
    render(<LandingHeader />);

    const dismissButton = screen.getByRole("button", { name: /Dismiss landing header/ });
    fireEvent.click(dismissButton);

    expect(screen.queryByText(/Will META close/)).not.toBeInTheDocument();
  });

  it("persists dismissal in localStorage", () => {
    render(<LandingHeader />);

    const dismissButton = screen.getByRole("button", { name: /Dismiss landing header/ });
    fireEvent.click(dismissButton);

    expect(localStorage.getItem("meridian-landing-header-dismissed")).toBe("true");
  });

  it("stays dismissed on remount", () => {
    localStorage.setItem("meridian-landing-header-dismissed", "true");

    const { rerender } = render(<LandingHeader />);

    expect(screen.queryByText(/Will META close/)).not.toBeInTheDocument();

    rerender(<LandingHeader />);
    expect(screen.queryByText(/Will META close/)).not.toBeInTheDocument();
  });

  it("shows header when not dismissed", () => {
    localStorage.setItem("meridian-landing-header-dismissed", "false");

    render(<LandingHeader />);

    expect(screen.getByText(/Will META close/)).toBeInTheDocument();
  });
});
