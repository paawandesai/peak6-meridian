/**
 * M4-08: Tests for demo replay banner.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DemoReplayBanner } from "./DemoReplayBanner";

describe("DemoReplayBanner", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("renders nothing in live mode", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "live";
    const { container } = render(<DemoReplayBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when mode is unset", () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    delete process.env.NEXT_PUBLIC_DEMO_REPLAY_DATE;
    const { container } = render(<DemoReplayBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders banner in replay mode with date", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "replay";
    process.env.NEXT_PUBLIC_DEMO_REPLAY_DATE = "2024-10-08";
    render(<DemoReplayBanner />);
    expect(
      screen.getByText(/DEMO: Replaying historical trading day 2024-10-08/),
    ).toBeInTheDocument();
  });

  it("renders nothing in replay mode without date", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "replay";
    delete process.env.NEXT_PUBLIC_DEMO_REPLAY_DATE;
    const { container } = render(<DemoReplayBanner />);
    expect(container.firstChild).toBeNull();
  });
});
