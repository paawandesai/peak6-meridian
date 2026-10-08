import { PublicKey } from "@solana/web3.js";
import { fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({ publicKey: null as PublicKey | null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => wallet }));

import { loadWalletEvents, type HistoryRpc } from "./history-chain";
import { buildRows, filterRows, formatEtDateTime, isWalletEvent, ALL } from "./history-model";
import { CONNECT_TEXT, EMPTY_TEXT, HistoryView, NO_MATCH_TEXT } from "./history-view";
import { explorerTxUrl } from "@/lib/admin-chain";
import { parsePublicConfig } from "@/lib/config";
import { decodeEvents, type MeridianEvent } from "@/lib/events";
import fixture from "@/lib/fixtures/events.json";
import { market } from "@/test-utils";

const events = decodeEvents(
  fixture.logs,
  { signature: fixture.signature, blockTime: fixture.blockTime },
  fixture.programId,
);
const kind = <K extends MeridianEvent["kind"]>(k: K) =>
  events.find((e) => e.kind === k) as Extract<MeridianEvent, { kind: K }>;
const fill = kind("Fill");
const markets = [
  market({ address: fill.market, ticker: "AAPL", strikeCents: 23_000n, tradingDate: 20261008 }),
];
const url = (signature: string) => `https://explorer.test/tx/${signature}`;

afterEach(() => {
  wallet.publicKey = null;
});

const rowFor = (action: string, as: string) =>
  buildRows(events, as, new Map(markets.map((m) => [m.address, m]))).find(
    (r) => r.action === action,
  );

describe("rows from M2-05's fixture (AC1: every event type, right fields)", () => {
  it("renders every decoded event type with its fields", () => {
    wallet.publicKey = new PublicKey(fill.taker);
    render(<HistoryView events={events} markets={markets} explorerUrl={url} />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(events.length);
    const text = (action: string) =>
      rows.find((r) => within(r).queryAllByText(action, { selector: "td" }).length > 0)
        ?.textContent ?? "";
    expect(text("Fill")).toContain("Buy YES");
    expect(text("Fill")).toContain("60¢");
    expect(text("Fill")).toContain("10");
    expect(text("Order placed")).toContain("Sell YES");
    expect(text("Order placed")).toContain("Order #7");
    expect(text("Cancel")).toContain("Order #8");
    expect(text("Mint")).toContain("20");
    expect(text("Redeem")).toContain("Paid 10.00 test-USDC");
    expect(text("Withdraw")).toContain("10 YES");
    expect(text("Market created")).toContain("AAPL strike $230");
    expect(text("Market settled")).toContain("Settled YES");
    expect(text("Fill")).toContain("AAPL ≥ $230 · 2026-10-08");
  });

  it("shows the wallet's own side on a fill (maker sees the opposite of the taker)", () => {
    expect(rowFor("Fill", fill.taker)?.side).toBe("Buy YES");
    expect(rowFor("Fill", fill.maker)?.side).toBe("Sell YES");
  });

  it("labels redeem sides", () => {
    expect(rowFor("Redeem", "x")?.side).toBe("YES");
    const redeemed = kind("Redeemed");
    const both = buildRows([{ ...redeemed, noQty: 4n }], "x", new Map())[0];
    expect(both).toMatchObject({ side: "YES + NO", qty: 14n });
    expect(buildRows([{ ...redeemed, yesQty: 0n, noQty: 4n }], "x", new Map())[0]?.side).toBe("NO");
  });

  it("falls back to a short address for an unknown market", () => {
    const row = buildRows([fill], fill.taker, new Map())[0];
    expect(row?.market).toMatch(/^\w{4}…\w{4}$/);
  });
});

describe("ET times (UI-06 AC1, DST boundaries)", () => {
  const utc = (iso: string) => Date.parse(iso) / 1000;
  it("spring forward: 06:59:59Z is EST, 07:00:00Z is EDT", () => {
    expect(formatEtDateTime(utc("2026-03-08T06:59:59Z"))).toBe("2026-03-08 01:59:59 ET");
    expect(formatEtDateTime(utc("2026-03-08T07:00:00Z"))).toBe("2026-03-08 03:00:00 ET");
  });
  it("fall back: 05:59:59Z is EDT, 06:00:00Z is EST", () => {
    expect(formatEtDateTime(utc("2026-11-01T05:59:59Z"))).toBe("2026-11-01 01:59:59 ET");
    expect(formatEtDateTime(utc("2026-11-01T06:00:00Z"))).toBe("2026-11-01 01:00:00 ET");
  });
  it("renders midnight as 00:00:00, not 24:00:00", () => {
    expect(formatEtDateTime(utc("2026-01-05T05:00:00Z"))).toBe("2026-01-05 00:00:00 ET");
  });
  it("shows a dash when there is no block time", () => {
    expect(buildRows([{ ...fill, blockTime: null }], fill.taker, new Map())[0]?.timeEt).toBe("—");
  });
});

describe("ordering and filters", () => {
  it("sorts newest first, unknown times last (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.integer({ min: 1, max: 2_000_000_000 })), { maxLength: 12 }),
        (times) => {
          const rows = buildRows(
            times.map((t, i) => ({ ...fill, signature: `s${i}`, blockTime: t })),
            fill.taker,
            new Map(),
          );
          const seen = rows.map((r) => r.blockTime ?? -1);
          expect(seen).toEqual([...seen].sort((a, b) => b - a));
        },
      ),
    );
  });

  it("filters by market and action", () => {
    const rows = buildRows(events, fill.taker, new Map());
    expect(filterRows(rows, ALL, ALL)).toHaveLength(events.length);
    expect(filterRows(rows, ALL, "Fill")).toHaveLength(1);
    expect(filterRows(rows, "nope", ALL)).toHaveLength(0);
    expect(filterRows(rows, fill.market, "Mint")).toHaveLength(1);
  });

  it("filter controls narrow the table and are native, keyboard-operable selects", () => {
    wallet.publicKey = new PublicKey(fill.taker);
    render(<HistoryView events={events} markets={markets} explorerUrl={url} />);
    const action = screen.getByLabelText("Action");
    expect(action.tagName).toBe("SELECT");
    fireEvent.change(action, { target: { value: "Mint" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Market"), { target: { value: "other" } });
    expect(screen.getByText(NO_MATCH_TEXT)).toBeInTheDocument();
  });
});

describe("explorer links (UI-06 AC2) and states", () => {
  it("links each signature to the devnet explorer with the cluster parameter", () => {
    wallet.publicKey = new PublicKey(fill.taker);
    const config = parsePublicConfig({
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
    });
    render(
      <HistoryView
        events={[fill]}
        markets={markets}
        explorerUrl={(s) => explorerTxUrl(s, config)}
      />,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      `https://explorer.solana.com/tx/${fixture.signature}?cluster=devnet`,
    );
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("asks a disconnected visitor to connect", () => {
    render(<HistoryView events={events} markets={markets} explorerUrl={url} />);
    expect(screen.getByText(CONNECT_TEXT)).toBeInTheDocument();
  });

  it("shows an empty state", () => {
    wallet.publicKey = new PublicKey(fill.taker);
    render(<HistoryView events={[]} markets={markets} explorerUrl={url} />);
    expect(screen.getByText(EMPTY_TEXT)).toBeInTheDocument();
  });
});

describe("loadWalletEvents", () => {
  const me = new PublicKey(fill.taker);
  const tx = (logs: string[] | null) => ({
    blockTime: fixture.blockTime,
    meta: { logMessages: logs },
  });
  const rpcWith = (
    sigs: { signature: string; err: unknown; blockTime?: number | null }[],
    txs: unknown[],
  ): HistoryRpc =>
    ({
      getSignaturesForAddress: vi.fn().mockResolvedValue(sigs),
      getTransactions: vi.fn().mockResolvedValue(txs),
    }) as unknown as HistoryRpc;

  it("decodes the wallet's own events and drops other wallets' and market events", async () => {
    const rpc = rpcWith([{ signature: fixture.signature, err: null }], [tx(fixture.logs)]);
    const out = await loadWalletEvents(rpc, me, new PublicKey(fixture.programId));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => isWalletEvent(e, me.toBase58()))).toBe(true);
    expect(out.some((e) => e.kind === "MarketCreated")).toBe(false);
    expect(out.find((e) => e.kind === "Fill")?.blockTime).toBe(fixture.blockTime);
  });

  it("skips failed transactions and missing logs, and returns [] with no signatures", async () => {
    const empty = rpcWith([], []);
    expect(await loadWalletEvents(empty, me, new PublicKey(fixture.programId))).toEqual([]);
    expect(empty.getTransactions).not.toHaveBeenCalled();
    const rpc = rpcWith(
      [
        { signature: "failed", err: { InstructionError: [0, "x"] } },
        { signature: "nologs", err: null },
        { signature: "gone", err: null },
      ],
      [tx(null), null],
    );
    expect(await loadWalletEvents(rpc, me, new PublicKey(fixture.programId))).toEqual([]);
    expect(rpc.getTransactions).toHaveBeenCalledWith(["nologs", "gone"], expect.anything());
  });

  it("propagates RPC failures", async () => {
    const rpc = {
      getSignaturesForAddress: vi.fn().mockRejectedValue(new Error("rpc down")),
    } as unknown as HistoryRpc;
    await expect(loadWalletEvents(rpc, me, new PublicKey(fixture.programId))).rejects.toThrow(
      "rpc down",
    );
  });
});
