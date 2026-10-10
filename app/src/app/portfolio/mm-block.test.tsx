import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OpenOrdersRow, RestingOrder } from "./data";
import { AAPL, NVDA } from "./fixtures";
import { buildMmBlock, type MmBlockModel } from "./mm";
import { MM_HEADING, MM_MISMATCH_NOTE, MmBlock } from "./mm-block";

const bid = (price: number, qty: bigint, orderId: bigint): RestingOrder => ({
  market: NVDA.address,
  orderId,
  side: "Bid",
  price,
  qty,
});
const ask = (price: number, qty: bigint, orderId: bigint): RestingOrder => ({
  ...bid(price, qty, orderId),
  side: "Ask",
});

/** An MM with two bids and one ask on NVDA $180 and an unsettled balance on AAPL. */
function mmModel(overrides: { openOrders?: OpenOrdersRow[]; resting?: RestingOrder[] } = {}) {
  return buildMmBlock({
    markets: [NVDA, AAPL],
    openOrders: overrides.openOrders ?? [
      { market: NVDA.address, freeUsdc: 1_500_000n, freeYes: 5n, restingCount: 3 },
      { market: AAPL.address, freeUsdc: 4_000_000n, freeYes: 0n, restingCount: 0 },
    ],
    resting: overrides.resting ?? [bid(58, 10n, 1n), bid(57, 20n, 2n), ask(61, 10n, 3n)],
    netByMarket: new Map([[NVDA.address, 15n]]),
  });
}

function show(mm: MmBlockModel, busy = false) {
  const onWithdraw = vi.fn();
  render(<MmBlock mm={mm} busy={busy} onWithdraw={onWithdraw} />);
  return { onWithdraw, block: screen.getByRole("region", { name: new RegExp(MM_HEADING) }) };
}

/** The text of each cell of the row whose header is `label`. */
function rowCells(block: HTMLElement, label: string): string[] {
  const header = within(block).getByRole("rowheader", { name: label });
  const row = header.closest("tr");
  if (row === null) throw new Error("row header outside a row");
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent ?? "");
}

describe("MmBlock", () => {
  it("collapses to one line for a wallet with no resting orders and nothing to withdraw", () => {
    const { block } = show(
      buildMmBlock({ markets: [NVDA], openOrders: [], resting: [], netByMarket: new Map() }),
    );
    expect(block).toHaveTextContent(`${MM_HEADING}: no open orders.`);
    expect(within(block).queryByRole("table")).toBeNull();
    expect(within(block).queryByRole("button")).toBeNull();
  });

  it("shows one dense row per strike with exposure, own orders, escrow and unsettled balance", () => {
    const { block } = show(mmModel());
    const table = within(block).getByRole("table", { name: "Net exposure per strike" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual([
      "Strike",
      "Net",
      "If bids fill",
      "If asks fill",
      "Bids qty @ best",
      "Asks qty @ best",
      "Orders",
      "Bid escrow",
      "Unsettled",
    ]);
    // Net +15; if bids fill +45, if asks fill +5; 30 bid @ 58¢, 10 ask @ 61¢; 3 orders;
    // escrow 58×10 + 57×20 = $17.20; unsettled $1.50 + 5 YES.
    expect(rowCells(block, "NVDA ≥ $180 10/08")).toEqual([
      "+15",
      "+45",
      "+5",
      "30 @ 58¢",
      "10 @ 61¢",
      "3",
      "$17.20",
      "$1.50 + 5 YES",
    ]);
    expect(rowCells(block, "AAPL ≥ $230 10/07")).toEqual([
      "0",
      "0",
      "0",
      "—",
      "—",
      "0",
      "—",
      "$4.00",
    ]);
    // Rows are sorted: AAPL before NVDA.
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["AAPL ≥ $230 10/07", "NVDA ≥ $180 10/08"]);
  });

  it("totals the strikes in the footer and in the summary line", () => {
    const { block } = show(mmModel());
    const footer = within(block).getByText("Total").closest("tr");
    if (footer === null) throw new Error("no totals row");
    expect(
      within(footer)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Total", "", "", "", "30", "10", "3", "$17.20", "$5.50 + 5 YES"]);
    expect(block).toHaveTextContent("Open orders 3");
    expect(block).toHaveTextContent("Bid escrow $17.20");
    expect(block).toHaveTextContent("Unsettled $5.50 + 5 YES");
  });

  it("omits the totals row for a single strike", () => {
    const { block } = show(
      mmModel({
        openOrders: [{ market: NVDA.address, freeUsdc: 0n, freeYes: 0n, restingCount: 1 }],
        resting: [bid(40, 2n, 1n)],
      }),
    );
    expect(within(block).queryByText("Total")).toBeNull();
    expect(within(block).queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("hides the secondary columns below md so 390 px keeps Strike, Net, Orders, Unsettled", () => {
    const { block } = show(mmModel());
    const table = within(block).getByRole("table");
    const narrow = within(table)
      .getAllByRole("columnheader")
      .filter((cell) => !cell.className.includes("hidden md:table-cell"))
      .map((cell) => cell.textContent);
    expect(narrow).toEqual(["Strike", "Net", "Orders", "Unsettled"]);
    // Every body and footer cell in a hidden column is hidden too, so columns stay aligned.
    for (const row of within(table).getAllByRole("row")) {
      const flags = Array.from(row.children).map((cell) =>
        cell.className.includes("hidden md:table-cell"),
      );
      expect(flags).toEqual([false, false, true, true, true, true, false, true, false]);
    }
  });

  it("Withdraw calls back", () => {
    const { block, onWithdraw } = show(mmModel());
    fireEvent.click(within(block).getByRole("button", { name: "Withdraw" }));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });

  it("disables Withdraw while busy", () => {
    const { block } = show(mmModel(), true);
    expect(within(block).getByRole("button", { name: "Withdraw" })).toBeDisabled();
  });

  it("marks a strike whose book read disagrees with resting_count and explains it", () => {
    const { block } = show(
      mmModel({
        openOrders: [{ market: NVDA.address, freeUsdc: 0n, freeYes: 0n, restingCount: 2 }],
        resting: [bid(40, 2n, 1n)],
      }),
    );
    expect(rowCells(block, "NVDA ≥ $180 10/08")[5]).toBe("2 (book 1)");
    expect(within(block).getByRole("note")).toHaveTextContent(MM_MISMATCH_NOTE);
  });

  it("shows no mismatch note when the book agrees", () => {
    const { block } = show(mmModel());
    expect(within(block).queryByRole("note")).toBeNull();
  });
});
