import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppHeader, NAV_ITEMS, PAUSE_BANNER_TEXT } from "./app-header";
import HomePage from "@/app/page";
import { market, reader, withReader } from "@/test-utils";

vi.mock("@solana/wallet-adapter-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/wallet-adapter-react")>()),
  useWallet: () => ({ publicKey: null }),
}));
vi.mock("./wallet-button", () => ({
  WalletButton: () => <button type="button">Select Wallet</button>,
}));

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const date = 20261008;
const CLOSE = utc("2026-10-08T20:00:00Z"); // 16:00 ET

function header(props: Partial<React.ComponentProps<typeof AppHeader>> = {}) {
  return render(
    withReader(
      reader(),
      <AppHeader nowSecs={utc("2026-10-08T18:52:07Z")} markets={[]} config={null} {...props} />,
    ),
  );
}

describe("clock (AC4)", () => {
  it("is a stable placeholder before mount (server and first client render)", () => {
    header({ nowSecs: null, markets: null });
    expect(screen.getByTestId("et-clock")).toHaveTextContent("--:--:-- ET");
    expect(screen.getByTestId("next-close")).toHaveTextContent("--:--");
  });

  it("the prerendered shell contains the placeholder, so there is no hydration mismatch", () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html).toContain("--:--:-- ET");
    expect(html).toContain("Loading markets");
  });

  it("shows ET with Intl across a DST boundary", () => {
    header({ nowSecs: utc("2026-03-08T07:00:00Z") }); // spring forward: 03:00:00 EDT
    expect(screen.getByTestId("et-clock")).toHaveTextContent("03:00:00 ET");
  });
});

describe("next close (AC4)", () => {
  it("counts down to the earliest open close_ts", () => {
    header({
      nowSecs: CLOSE - 724,
      markets: [market({ tradingDate: date, closeTs: BigInt(CLOSE) })],
    });
    expect(screen.getByTestId("next-close")).toHaveTextContent("Closes in 12:04");
  });

  it("an early-close day counts down to its own 13:00 ET close_ts", () => {
    const early = utc("2026-11-27T18:00:00Z"); // 13:00 EST
    header({
      nowSecs: early - 3_600,
      markets: [market({ tradingDate: 20261127, closeTs: BigInt(early) })],
    });
    expect(screen.getByTestId("next-close")).toHaveTextContent("Closes in 1:00:00");
  });

  it("a market in its final 15 minutes still drives the countdown, not 'Closed · settling'", () => {
    header({
      nowSecs: CLOSE - 300,
      markets: [market({ tradingDate: date, closeTs: BigInt(CLOSE) })],
    });
    expect(screen.getByTestId("next-close")).toHaveTextContent("Closes in 05:00");
    expect(screen.getByTestId("next-close")).not.toHaveTextContent("settling");
  });

  it.each([
    ["No markets today", [], CLOSE],
    ["Closed · settling", [market({ tradingDate: date, closeTs: BigInt(CLOSE) })], CLOSE + 10],
    ["Settlement delayed", [market({ tradingDate: date, closeTs: BigInt(CLOSE) })], CLOSE + 1_500],
    [
      "Markets closed",
      [market({ tradingDate: date, closeTs: BigInt(CLOSE), settled: true })],
      CLOSE + 5_000,
    ],
  ])("empty state: %s", (text, markets, now) => {
    header({ nowSecs: now, markets });
    expect(screen.getByTestId("next-close")).toHaveTextContent(text);
  });
});

describe("pause banner slot", () => {
  it("shows the pause text on every page when paused, and nothing otherwise", () => {
    const { unmount } = header({ config: { paused: true, overrideDelaySecs: 3600n, admin: "A" } });
    expect(screen.getByRole("status")).toHaveTextContent(PAUSE_BANNER_TEXT);
    unmount();
    header({ config: { paused: false, overrideDelaySecs: 3600n, admin: "A" } });
    expect(screen.queryByText(PAUSE_BANNER_TEXT)).toBeNull();
  });
});

describe("navigation and layout (AC5)", () => {
  it("lists Markets, Portfolio, History and Status as links and marks the current page", () => {
    header({ currentPath: "/portfolio" });
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(NAV_ITEMS.map((item) => item.label));
    expect(within(nav).getByRole("link", { name: "Portfolio" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Markets" })).not.toHaveAttribute("aria-current");
  });

  it("nav links and the wallet button are keyboard-reachable (no tabindex=-1)", () => {
    header();
    for (const link of screen.getAllByRole("link"))
      expect(link).not.toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Select Wallet" })).not.toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("the shell uses responsive wrapping and no fixed pixel widths (class-level; jsdom does no layout)", () => {
    const sources = ["app-header.tsx", "app-shell.tsx"].map((f) =>
      readFileSync(join(process.cwd(), "src/components", f), "utf8"),
    );
    for (const source of sources) {
      expect(source).not.toMatch(/\b(?:min-|max-)?w-\[\d+px\]/);
      expect(source).not.toMatch(/style=\{\{[^}]*(?:width|minWidth)/);
    }
    expect(sources[0]).toContain("flex-wrap");
  });

  it("globals.css draws one visible focus ring from the focus token for every focusable element", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--mer-focus\)[^}]*outline-offset:\s*2px/,
    );
    for (const element of ["a", "button", "input", "select", "textarea", "\\[tabindex\\]"]) {
      expect(css).toMatch(new RegExp(`:where\\([^)]*${element}[^)]*\\):focus-visible`));
    }
  });
});
