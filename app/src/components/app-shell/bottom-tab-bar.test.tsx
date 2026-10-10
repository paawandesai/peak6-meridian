import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BottomTabBar } from "./bottom-tab-bar";

// Mock next/navigation
const mockPathname = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

describe("BottomTabBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname.mockReturnValue("/");
  });

  it("renders all 4 tabs", () => {
    render(<BottomTabBar />);

    expect(screen.getByRole("link", { name: /Markets/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Portfolio/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /History/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Status/ })).toBeInTheDocument();
  });

  it("has correct hrefs", () => {
    render(<BottomTabBar />);

    expect(screen.getByRole("link", { name: /Markets/ })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /Portfolio/ })).toHaveAttribute("href", "/portfolio");
    expect(screen.getByRole("link", { name: /History/ })).toHaveAttribute("href", "/history");
    expect(screen.getByRole("link", { name: /Status/ })).toHaveAttribute("href", "/status");
  });

  it("sets aria-current on active Markets tab", () => {
    mockPathname.mockReturnValue("/");
    render(<BottomTabBar />);

    const marketsTab = screen.getByRole("link", { name: /Markets/ });
    expect(marketsTab).toHaveAttribute("aria-current", "page");
  });

  it("sets aria-current on active Portfolio tab", () => {
    mockPathname.mockReturnValue("/portfolio");
    render(<BottomTabBar />);

    const portfolioTab = screen.getByRole("link", { name: /Portfolio/ });
    expect(portfolioTab).toHaveAttribute("aria-current", "page");
  });

  it("sets aria-current on active History tab", () => {
    mockPathname.mockReturnValue("/history");
    render(<BottomTabBar />);

    const historyTab = screen.getByRole("link", { name: /History/ });
    expect(historyTab).toHaveAttribute("aria-current", "page");
  });

  it("sets aria-current on active Status tab", () => {
    mockPathname.mockReturnValue("/status");
    render(<BottomTabBar />);

    const statusTab = screen.getByRole("link", { name: /Status/ });
    expect(statusTab).toHaveAttribute("aria-current", "page");
  });

  it("considers /trade routes as Markets active", () => {
    mockPathname.mockReturnValue("/trade/ABC123");
    render(<BottomTabBar />);

    const marketsTab = screen.getByRole("link", { name: /Markets/ });
    expect(marketsTab).toHaveAttribute("aria-current", "page");
  });

  it("has no aria-current on inactive tabs", () => {
    mockPathname.mockReturnValue("/portfolio");
    render(<BottomTabBar />);

    const marketsTab = screen.getByRole("link", { name: /Markets/ });
    expect(marketsTab).not.toHaveAttribute("aria-current");
  });

  it("has 44px minimum touch targets", () => {
    render(<BottomTabBar />);

    const tabs = screen.getAllByRole("link");
    tabs.forEach((tab) => {
      expect(tab).toHaveStyle({ minHeight: "44px" });
    });
  });

  it("has visible focus ring class", () => {
    render(<BottomTabBar />);

    const marketsTab = screen.getByRole("link", { name: /Markets/ });
    expect(marketsTab).toHaveClass("focus:ring-2");
  });

  it("has safe-area-inset-bottom for notched devices", () => {
    const { container } = render(<BottomTabBar />);

    const nav = container.querySelector("nav");
    expect(nav).toHaveStyle({ paddingBottom: "env(safe-area-inset-bottom)" });
  });

  it("is hidden above md breakpoint", () => {
    const { container } = render(<BottomTabBar />);

    const nav = container.querySelector("nav");
    expect(nav).toHaveClass("md:hidden");
  });

  it("is fixed at bottom", () => {
    const { container } = render(<BottomTabBar />);

    const nav = container.querySelector("nav");
    expect(nav).toHaveClass("fixed");
    expect(nav).toHaveClass("bottom-0");
  });

  it("has navigation aria-label", () => {
    render(<BottomTabBar />);

    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
  });

  it("renders icons for all tabs", () => {
    const { container } = render(<BottomTabBar />);

    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(4); // One icon per tab
  });

  it("applies active styles to current tab", () => {
    mockPathname.mockReturnValue("/");
    render(<BottomTabBar />);

    const marketsTab = screen.getByRole("link", { name: /Markets/ });
    expect(marketsTab).toHaveClass("text-mer-primary");
  });

  it("applies inactive styles to non-current tabs", () => {
    mockPathname.mockReturnValue("/");
    render(<BottomTabBar />);

    const portfolioTab = screen.getByRole("link", { name: /Portfolio/ });
    expect(portfolioTab).toHaveClass("text-mer-ink-muted");
  });
});
