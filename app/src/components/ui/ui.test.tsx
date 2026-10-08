import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AsOf, Cents, Countdown, PayoffSentence, Pnl, SideLabel, StateBadge, TxStatus } from ".";

describe("StateBadge: every state carries its words", () => {
  it.each([
    [{ state: "open" as const }, "Open"],
    [{ state: "closing-soon" as const, remaining: "12:04" }, "Closes in 12:04"],
    [{ state: "closed" as const, settlingAt: "16:05" }, "Closed, settling at 16:05 ET"],
    [{ state: "closed" as const, settlingAt: "13:05" }, "Closed, settling at 13:05 ET"],
    [{ state: "settling" as const }, "Settling…"],
    [{ state: "settling" as const, attempt: 3 }, "Settling… (attempt 3)"],
    [
      { state: "settlement-delayed" as const, overrideAt: "17:00" },
      "Settlement delayed: automatic settlement has stopped; an admin override opens at 17:00 ET",
    ],
    [
      { state: "settlement-delayed" as const, overrideAt: "now" as const },
      "Settlement delayed: automatic settlement has stopped; an admin override is available now",
    ],
    [
      { state: "settled" as const, outcome: "YES" as const, price: "$181.42" },
      "Settled YES at $181.42",
    ],
    [
      { state: "settled" as const, outcome: "NO" as const, price: "$178.10" },
      "Settled NO at $178.10",
    ],
    [
      { state: "paused" as const },
      "Paused: trading and minting stopped; cancel, withdraw and redeem still work",
    ],
  ])("%j shows %s", (props, text) => {
    render(<StateBadge {...props} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("Override pending, both texts, supplied through the optional prop only", () => {
    const { unmount } = render(
      <StateBadge
        state="settlement-delayed"
        overrideAt="17:00"
        overridePending={{ availableAt: "17:00" }}
      />,
    );
    expect(screen.getByText("Override pending, available at 17:00 ET")).toBeInTheDocument();
    unmount();
    render(
      <StateBadge
        state="settlement-delayed"
        overrideAt="now"
        overridePending={{ availableAt: "now" }}
      />,
    );
    expect(screen.getByText("Override pending, available now")).toBeInTheDocument();
  });

  it("shows the spinner only for Settling, always next to the word", () => {
    const { container, rerender } = render(<StateBadge state="settling" />);
    expect(container.querySelector(".mer-spin")).not.toBeNull();
    expect(container).toHaveTextContent("Settling…");
    rerender(<StateBadge state="settlement-delayed" overrideAt="17:00" />);
    expect(container.querySelector(".mer-spin")).toBeNull();
  });

  it("solid Settled fills take their text from the on-* tokens", () => {
    const { container, rerender } = render(
      <StateBadge state="settled" outcome="YES" price="$1.00" />,
    );
    expect(container.firstElementChild).toHaveClass("bg-mer-yes", "text-mer-on-yes");
    rerender(<StateBadge state="settled" outcome="NO" price="$1.00" />);
    expect(container.firstElementChild).toHaveClass("bg-mer-no", "text-mer-on-no");
  });
});

describe("SideLabel", () => {
  it("prints the full word with hue and an optional one-line meaning", () => {
    render(<SideLabel side="YES" meaning="pays $1.00 if NVDA closes at or above $180" />);
    expect(screen.getByText("YES")).toHaveClass("text-mer-yes");
    expect(screen.getByText(/pays \$1.00 if NVDA/)).toBeInTheDocument();
    render(<SideLabel side="NO" />);
    expect(screen.getByText("NO")).toHaveClass("text-mer-no");
  });
});

describe("Cents", () => {
  it("shows price and implied probability together, price first", () => {
    render(<Cents cents={62} />);
    expect(screen.getByText("62¢ · 62%")).toBeInTheDocument();
  });

  it("can hide the percentage and rejects non-integer cents", () => {
    render(<Cents cents={7} showPercent={false} />);
    expect(screen.getByText("7¢")).toBeInTheDocument();
    expect(() => render(<Cents cents={6.5} />)).toThrow(RangeError);
    expect(() => render(<Cents cents={101} />)).toThrow(RangeError);
  });
});

describe("AsOf", () => {
  it("is plain and unmuted-labelled while fresh", () => {
    render(<AsOf time="14:52:05" ageSecs={3} />);
    expect(screen.getByText("as of 14:52:05 ET")).toBeInTheDocument();
    expect(screen.queryByText(/stale/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("labels data older than 10 s as stale", () => {
    render(<AsOf time="14:52:05" ageSecs={11} />);
    expect(screen.getByText(/as of 14:52:05 ET · stale/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("adds the banner above 60 s, with the age in minutes", () => {
    render(<AsOf time="14:52:05" ageSecs={61} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Prices are 1 min old. Trading still works; check the book before you sign.",
    );
  });

  it("the boundaries are exclusive: exactly 10 s is fresh, exactly 60 s has no banner", () => {
    const { rerender } = render(<AsOf time="t" ageSecs={10} />);
    expect(screen.queryByText(/stale/)).toBeNull();
    rerender(<AsOf time="t" ageSecs={60} />);
    expect(screen.getByText(/stale/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Countdown", () => {
  it("shows the label and the remaining time, not as a live region", () => {
    const { container } = render(<Countdown secondsLeft={724} />);
    expect(container).toHaveTextContent("Closes in 12:04");
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector("[class*=animate]")).toBeNull();
  });

  it("clamps below zero", () => {
    const { container } = render(<Countdown secondsLeft={-3} />);
    expect(container).toHaveTextContent("00:00");
  });
});

describe("TxStatus: every state has text and an icon", () => {
  it.each([
    [{ state: "simulating" as const }, "Simulating…"],
    [{ state: "awaiting-signature" as const }, "Review and sign in your wallet"],
    [{ state: "confirming" as const }, "Confirming…"],
    [
      {
        state: "confirmed" as const,
        slot: 123456,
        explorerUrl: "https://explorer.solana.com/tx/x?cluster=devnet",
      },
      "Confirmed in slot 123456",
    ],
    [
      { state: "failed" as const, reason: "price moved" },
      "Failed: price moved. Nothing was charged.",
    ],
  ])("%j shows %s", (props, text) => {
    const { container } = render(<TxStatus {...props} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBeTruthy();
  });

  it("links the confirmed transaction and announces a failure", () => {
    const { unmount } = render(
      <TxStatus
        state="confirmed"
        slot={1}
        explorerUrl="https://explorer.solana.com/tx/abc?cluster=devnet"
      />,
    );
    expect(screen.getByRole("link", { name: "(view on explorer)" })).toHaveAttribute(
      "href",
      "https://explorer.solana.com/tx/abc?cluster=devnet",
    );
    unmount();
    render(<TxStatus state="failed" reason="x" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("Pnl", () => {
  it("prints the sign character and colours it by sign", () => {
    const { unmount } = render(<Pnl text="+$3.80" sign="gain" />);
    expect(screen.getByText("+$3.80")).toHaveClass("text-mer-gain");
    unmount();
    const loss = render(<Pnl text={"−$1.20"} sign="loss" />);
    expect(screen.getByText("−$1.20")).toHaveClass("text-mer-loss");
    loss.unmount();
    render(<Pnl text="$0.00" sign="zero" />);
    expect(screen.getByText("$0.00")).not.toHaveClass("text-mer-gain", "text-mer-loss");
  });
});

describe("PayoffSentence", () => {
  it("renders the sentence it is given and nothing else", () => {
    render(<PayoffSentence>You pay $3.80 for 10 contracts.</PayoffSentence>);
    expect(screen.getByText("You pay $3.80 for 10 contracts.")).toBeInTheDocument();
  });
});

describe("controls never use --mer-rule as their only boundary (AC2)", () => {
  const dir = join(process.cwd(), "src/components");
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

  it("scans the component sources", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)(
    "%s: no button, input, select, textarea or link carries a mer-rule border",
    (_file, source) => {
      for (const tag of source.matchAll(/<(button|input|select|textarea|a)\b[^>]*>/g)) {
        expect(tag[0]).not.toMatch(/mer-rule/);
      }
    },
  );
});
