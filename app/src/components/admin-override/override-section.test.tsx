import { PublicKey } from "@solana/web3.js";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({ publicKey: null as PublicKey | null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => wallet }));

import type { Draft } from "./drafts";
import type { OverrideActions } from "./override-chain";
import { EMPTY_TEXT, OverrideSection } from "./override-section";
import { CLOSE, DELAY, draft, MARKET_ADDRESS, NVDA, OTHER_ADDRESS } from "./test-support";
import { ADMIN, market, OWNER, reader, withReader } from "@/test-utils";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 60_000 });

const BEFORE = CLOSE + DELAY - 1;
const AT = CLOSE + DELAY;

function actions(overrides: Partial<OverrideActions> = {}): OverrideActions {
  return {
    approve: vi.fn().mockResolvedValue({ signature: "SIGOV", slot: 77 }),
    ...overrides,
  };
}

type Options = {
  now?: number | null;
  drafts?: Draft[] | Error;
  markets?: ReturnType<typeof market>[];
  delay?: bigint;
  a?: OverrideActions;
};

function view(o: Options = {}) {
  const a = o.a ?? actions();
  const loadDrafts = vi.fn(() =>
    o.drafts instanceof Error ? Promise.reject(o.drafts) : Promise.resolve(o.drafts ?? [draft()]),
  );
  const r = reader({
    getConfig: () =>
      Promise.resolve({
        paused: false,
        overrideDelaySecs: o.delay ?? BigInt(DELAY),
        admin: ADMIN.toBase58(),
      }),
    listMarkets: () => Promise.resolve(o.markets ?? [NVDA]),
  });
  const result = render(
    withReader(
      r,
      <OverrideSection
        nowSecs={o.now === undefined ? BEFORE : o.now}
        actions={a}
        explorerUrl={(s) => `https://explorer.test/tx/${s}`}
        loadDrafts={loadDrafts}
      />,
    ),
  );
  return { ...result, a, loadDrafts };
}

const approve = () => screen.getByRole("button", { name: "Approve" });

beforeEach(() => {
  wallet.publicKey = ADMIN;
  window.localStorage.clear();
});
afterEach(() => {
  wallet.publicKey = null;
});

describe("who sees it (AC2)", () => {
  it("shows nothing to a disconnected visitor and never asks for drafts", async () => {
    wallet.publicKey = null;
    const { container, loadDrafts } = view();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(loadDrafts).not.toHaveBeenCalled();
  });

  it("shows nothing to a non-admin wallet and never asks for drafts", async () => {
    wallet.publicKey = OWNER;
    const { container, loadDrafts } = view();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Pending decisions")).toBeNull();
    expect(loadDrafts).not.toHaveBeenCalled();
  });

  it("shows the admin wallet the Pending decisions section", async () => {
    view();
    expect(await screen.findByRole("heading", { name: "Pending decisions" })).toBeInTheDocument();
  });
});

describe("evidence (UI-08 AC1)", () => {
  it("shows per-source prices, spread, staleness, the note and the proposed price", async () => {
    view({ now: CLOSE + 600 });
    expect(await screen.findByText("NVDA $180 · 2026-10-08")).toBeInTheDocument();
    expect(screen.getByText("$181.42")).toBeInTheDocument(); // proposed
    const rows = screen.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("tiingo$181.40as of 16:05:00 ET, 5 min old");
    expect(rows).toContain("twelvedata$181.44as of 16:06:00 ET, 4 min old");
    expect(screen.getByText("2 bps (0.02%)")).toBeInTheDocument();
    expect(screen.getByTestId("draft-note")).toHaveTextContent(
      /settle job failed on an oracle timeout/,
    );
    expect(screen.queryByText(/outside the range/)).toBeNull();
  });

  it("warns when the proposed price is outside the source range", async () => {
    view({ drafts: [draft({ proposed_price_cents: 19_000 })] });
    expect(await screen.findByText(/outside the range of the source closes/)).toBeInTheDocument();
  });

  it("renders a hostile note as inert text", async () => {
    const note = '<img src=x onerror="alert(1)"> https://evil.test';
    const { container } = view({ drafts: [draft({ note })] });
    expect(await screen.findByTestId("draft-note")).toHaveTextContent(note);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("Approve is disabled before close + delay (AC1: before, at, after)", () => {
  it("before: disabled, with the time in ET and the reason", async () => {
    view({ now: BEFORE });
    await screen.findByText("NVDA $180 · 2026-10-08");
    expect(approve()).toBeDisabled();
    expect(screen.getByTestId("availability")).toHaveTextContent(
      "Override available at 17:00 ET (in 00:01)",
    );
    expect(
      screen.getByText("Approve opens at 17:00 ET, 3600 s after the close."),
    ).toBeInTheDocument();
    expect(approve()).toHaveAccessibleDescription(
      "Approve opens at 17:00 ET, 3600 s after the close.",
    );
  });

  it("at: enabled, available now", async () => {
    view({ now: AT });
    await screen.findByText("NVDA $180 · 2026-10-08");
    expect(approve()).toBeEnabled();
    expect(screen.getByTestId("availability")).toHaveTextContent("Override available now");
  });

  it("after: enabled", async () => {
    view({ now: AT + 5000 });
    await screen.findByText("NVDA $180 · 2026-10-08");
    expect(approve()).toBeEnabled();
  });

  it("derives the time from close_ts: 14:00 ET on an early close", async () => {
    const early = market({ ...NVDA, closeTs: BigInt(CLOSE - 3 * 3600) });
    view({ markets: [early], now: CLOSE - 3 * 3600 + 60 });
    await screen.findByText("NVDA $180 · 2026-10-08");
    expect(screen.getByTestId("availability")).toHaveTextContent(/^Override available at 14:00 ET/);
    expect(approve()).toBeDisabled();
  });

  it("derives the time from override_delay_secs: 16:30 ET with a 1800 s delay", async () => {
    view({ delay: 1800n, now: CLOSE + 100 });
    await screen.findByText("NVDA $180 · 2026-10-08");
    expect(screen.getByTestId("availability")).toHaveTextContent(/^Override available at 16:30 ET/);
  });

  it("stays disabled for a market that is already settled or unknown", async () => {
    const first = view({ markets: [market({ ...NVDA, settled: true })], now: AT });
    expect(await screen.findByText("Already settled")).toBeInTheDocument();
    expect(approve()).toBeDisabled();
    first.unmount();
    view({ markets: [], drafts: [draft({ market: OTHER_ADDRESS })], now: AT });
    expect(await screen.findByText("Unknown market")).toBeInTheDocument();
    expect(approve()).toBeDisabled();
  });
});

describe("Approve (AC3)", () => {
  it("signs once through the admin's wallet with the draft's price in integer cents, unchanged", async () => {
    const { a } = view({ now: AT });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Confirmed in slot 77")).toBeInTheDocument();
    expect(a.approve).toHaveBeenCalledExactlyOnceWith(MARKET_ADDRESS, 18_142n);
    expect(screen.getByRole("link", { name: "(view on explorer)" })).toHaveAttribute(
      "href",
      "https://explorer.test/tx/SIGOV",
    );
  });

  it("shows a declined signature and that nothing was charged, and can retry", async () => {
    const a = actions({
      approve: vi.fn().mockRejectedValue(new Error("User rejected the request")),
    });
    view({ now: AT, a });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(
      await screen.findByText("Failed: User rejected the request. Nothing was charged."),
    ).toBeInTheDocument();
    await waitFor(() => expect(approve()).toBeEnabled());
  });

  it("falls back to a plain message when the error has no text", async () => {
    view({ now: AT, a: actions({ approve: vi.fn().mockRejectedValue(new Error(" ")) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(
      await screen.findByText("Failed: the override was not sent. Nothing was charged."),
    ).toBeInTheDocument();
  });

  it("never signs when Approve is disabled", async () => {
    const { a } = view({ now: BEFORE });
    await screen.findByText("NVDA $180 · 2026-10-08");
    fireEvent.click(approve());
    expect(a.approve).not.toHaveBeenCalled();
  });
});

describe("Reject", () => {
  it("hides the draft, signs nothing, and keeps it hidden after a reload", async () => {
    const first = view({ now: AT, drafts: [draft(), draft({ incident_id: "inc-2" })] });
    await screen.findAllByRole("button", { name: "Reject" });
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0] as HTMLElement);
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(first.a.approve).not.toHaveBeenCalled();
    first.unmount();
    view({ now: AT, drafts: [draft(), draft({ incident_id: "inc-2" })] });
    await screen.findAllByRole("button", { name: "Approve" });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1));
  });
});

describe("the list", () => {
  it("lists only drafts that are pending approval", async () => {
    view({ drafts: [draft(), draft({ incident_id: "inc-2", status: "accepted" })] });
    await screen.findByText("NVDA $180 · 2026-10-08");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("says when there is nothing pending", async () => {
    view({ drafts: [] });
    expect(await screen.findByText(EMPTY_TEXT)).toBeInTheDocument();
  });

  it("reports a draft load failure in words", async () => {
    view({ drafts: new Error("the ops agent could not be reached (502)") });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load drafts: the ops agent could not be reached (502)",
    );
  });

  it("reports a markets read failure", async () => {
    const r = reader({
      getConfig: () =>
        Promise.resolve({ paused: false, overrideDelaySecs: 3600n, admin: ADMIN.toBase58() }),
      listMarkets: () => Promise.reject(new Error("rpc down")),
    });
    render(
      withReader(
        r,
        <OverrideSection
          nowSecs={AT}
          actions={actions()}
          explorerUrl={String}
          loadDrafts={() => Promise.resolve([draft()])}
        />,
      ),
    );
    expect(await screen.findByText("Could not read the markets: rpc down")).toBeInTheDocument();
  });

  it("waits for the clock before showing anything actionable", async () => {
    view({ now: null });
    expect(await screen.findByText("Loading pending decisions…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    void within;
  });
});
