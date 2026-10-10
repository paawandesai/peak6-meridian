import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DemoBadge,
  DemoBanner,
  DemoMarketHeader,
  ReplayBanner,
  SessionBanners,
} from "./demo-banner";
import { AppHeader } from "./app-header";
import { parseDemoRegistry } from "@/lib/demo-session";
import { market, reader, withReader } from "@/test-utils";

vi.mock("@solana/wallet-adapter-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/wallet-adapter-react")>()),
  useWallet: () => ({ publicKey: null }),
}));
vi.mock("./wallet-button", () => ({ WalletButton: () => null }));

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const DEMO_CLOSE = utc("2026-10-12T00:00:00Z"); // Sun Oct 11, 8:00 PM ET
const NOW = utc("2026-10-11T15:00:00Z");
const REGISTRY = parseDemoRegistry(
  JSON.stringify([
    {
      tradingDate: 20261011,
      asOf: 20261009,
      closeTs: DEMO_CLOSE,
      createdAt: "2026-10-10T15:00:00Z",
      tickers: ["AAPL"],
      strikesByTicker: { AAPL: [22_000] },
      asOfCloseCentsByTicker: { AAPL: 22_512 },
    },
  ]),
);
const DEMO = market({ address: "demo", tradingDate: 20261011, closeTs: BigInt(DEMO_CLOSE) });
const REAL = market({
  address: "real",
  tradingDate: 20261009,
  closeTs: BigInt(utc("2026-10-09T20:00:00Z")),
});
const BANNER =
  "DEMO SESSION · simulates Fri Oct 9, 2026 · trading closes Sun Oct 11, 8:00 PM ET · devnet, no real funds";

afterEach(() => window.history.pushState({}, "", "/"));

describe("DemoBanner", () => {
  it("shows the full demo-session line while a demo market is open", () => {
    render(<DemoBanner markets={[REAL, DEMO]} nowSecs={NOW} registry={REGISTRY} />);
    expect(screen.getByTestId("demo-banner")).toHaveTextContent(BANNER);
  });

  it("renders nothing for real-session markets only", () => {
    render(<DemoBanner markets={[REAL]} nowSecs={NOW} registry={REGISTRY} />);
    expect(screen.queryByTestId("demo-banner")).toBeNull();
  });

  it("renders nothing before mount or before markets load", () => {
    const { container } = render(
      <>
        <DemoBanner markets={null} nowSecs={NOW} registry={REGISTRY} />
        <DemoBanner markets={[DEMO]} nowSecs={null} registry={REGISTRY} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to 'not a real market day' for an unregistered demo market", () => {
    render(<DemoBanner markets={[DEMO]} nowSecs={NOW} registry={parseDemoRegistry("")} />);
    expect(screen.getByTestId("demo-banner")).toHaveTextContent(/^DEMO · not a real market day/);
  });
});

describe("DemoBadge and DemoMarketHeader", () => {
  it("badges demo markets with the simulated date", () => {
    render(<DemoBadge market={DEMO} registry={REGISTRY} />);
    expect(screen.getByTestId("demo-badge")).toHaveTextContent("DEMO · simulates Fri Oct 9, 2026");
  });

  it("leaves real markets unbadged", () => {
    const { container } = render(
      <>
        <DemoBadge market={REAL} registry={REGISTRY} />
        <DemoMarketHeader market={REAL} registry={REGISTRY} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("puts the badge and the on-chain close on the Trade header of a demo market", () => {
    render(<DemoMarketHeader market={DEMO} registry={REGISTRY} />);
    const header = screen.getByTestId("demo-market-header");
    expect(header).toHaveTextContent("DEMO · simulates Fri Oct 9, 2026");
    expect(header).toHaveTextContent("trading closes Sun Oct 11, 8:00 PM ET (on-chain close)");
  });
});

describe("ReplayBanner", () => {
  it("shows the read-only replay bar with an exit link", () => {
    render(
      <ReplayBanner
        state={{
          kind: "replay",
          raw: "2026-10-09T10:30",
          tradingDate: 20261009,
          atSecs: utc("2026-10-09T14:30:00Z"),
        }}
      />,
    );
    expect(screen.getByTestId("replay-banner")).toHaveTextContent(
      "REPLAY · Fri Oct 9, 2026 10:30 AM ET · read-only",
    );
    expect(screen.getByRole("link", { name: "Exit replay" })).toHaveAttribute("href", "/");
  });

  it("shows a visible notice for an invalid link", () => {
    render(<ReplayBanner state={{ kind: "invalid", raw: "x", reason: "bad form" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Replay link ignored (bad form). Showing live markets.",
    );
  });

  it("renders nothing live or before mount", () => {
    const { container } = render(
      <>
        <ReplayBanner state={null} />
        <ReplayBanner state={{ kind: "live" }} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SessionBanners (reads ?replay= after mount)", () => {
  it("shows the replay bar for a valid ?replay= on Markets", async () => {
    window.history.pushState({}, "", "/?replay=2026-10-09T10:30");
    render(<SessionBanners markets={[]} nowSecs={NOW} />);
    expect(await screen.findByTestId("replay-banner")).toHaveTextContent(
      "REPLAY · Fri Oct 9, 2026 10:30 AM ET · read-only",
    );
  });

  it("shows the notice and stays live for an invalid ?replay=", async () => {
    window.history.pushState({}, "", "/?replay=yesterday");
    render(<SessionBanners markets={[]} nowSecs={NOW} />);
    expect(await screen.findByTestId("replay-invalid")).toHaveTextContent(/Showing live markets/);
    expect(screen.queryByTestId("replay-banner")).toBeNull();
  });

  it("ignores ?replay= on pages replay does not cover", async () => {
    window.history.pushState({}, "", "/portfolio?replay=2026-10-09T10:30");
    render(<SessionBanners markets={[]} nowSecs={NOW} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("replay-banner")).toBeNull();
    expect(screen.queryByTestId("replay-invalid")).toBeNull();
  });

  it("re-reads on back/forward navigation", async () => {
    window.history.pushState({}, "", "/?replay=2026-10-09T10:30");
    render(<SessionBanners markets={[]} nowSecs={NOW} />);
    await screen.findByTestId("replay-banner");
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.waitFor(() => expect(screen.queryByTestId("replay-banner")).toBeNull());
  });
});

describe("AppHeader", () => {
  it("leaves the header of a real session unchanged: no demo or replay banner", async () => {
    render(withReader(reader(), <AppHeader nowSecs={NOW} markets={[REAL]} config={null} />));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("demo-banner")).toBeNull();
    expect(screen.queryByTestId("replay-banner")).toBeNull();
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });

  it("carries the demo banner on every page that mounts the header", () => {
    render(withReader(reader(), <AppHeader nowSecs={NOW} markets={[DEMO]} config={null} />));
    expect(screen.getByTestId("demo-banner")).toHaveTextContent(/devnet, no real funds/);
  });
});
