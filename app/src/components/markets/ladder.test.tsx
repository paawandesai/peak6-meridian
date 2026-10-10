import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarketsView } from "../markets-view";
import { MarketSourcesProvider, type MarketSources } from "./data-context";
import { MIDPOINT_NOTE, SETTLE_NOTE, CONNECT_COPY } from "./notes";
import { market, reader, withReader } from "@/test-utils";

const wallet = vi.hoisted(() => ({ publicKey: null as unknown }));
vi.mock("@solana/wallet-adapter-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/wallet-adapter-react")>()),
  useWallet: () => wallet,
}));

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const NOW = utc("2026-10-08T19:00:00Z"); // 15:00 ET
const TODAY = 20261008;
const CLOSE = BigInt(utc("2026-10-08T20:00:00Z")); // 16:00 ET
const OPEN = utc("2026-10-08T13:00:00Z"); // 09:00 ET

type Q = {
  yesBid: number | null;
  yesAsk: number | null;
  yesMid: number | null;
  noPrice: number | null;
};
const q = (bid: number | null, ask: number | null): Q => ({
  yesBid: bid,
  yesAsk: ask,
  yesMid: bid !== null && ask !== null ? Math.floor((bid + ask) / 2) : null,
  noPrice: null,
});

function sources(options: {
  books?: Record<string, Q | null>;
  prices?: { ticker: string; price_cents: number }[];
  open?: Record<string, number | null>;
}): MarketSources {
  return {
    data: {
      fetchPrices: () =>
        Promise.resolve({
          prices: (options.prices ?? []).map((p) => ({
            ...p,
            ticker: p.ticker as never,
            as_of: new Date((NOW - 3) * 1000).toISOString(),
            stale: false,
          })),
          unavailable: [],
        }),
      fetchBooks: () => Promise.resolve(options.books ?? ({} as never)),
    },
    openTimes: () => Promise.resolve(options.open ?? {}),
  };
}

const addr = (n: number) => `1111111111111111111111111111111${n}`;
const m = (n: number, over: Parameters<typeof market>[0] = {}) =>
  market({
    address: addr(n),
    ticker: "NVDA",
    tradingDate: TODAY,
    closeTs: CLOSE,
    strikeCents: BigInt(17_000 + n * 1_000),
    ...over,
  });

function renderView(
  markets: ReturnType<typeof market>[],
  opts: {
    sources?: MarketSources;
    now?: number;
    paused?: boolean;
    tradeHref?: (x: ReturnType<typeof market>) => string;
  } = {},
) {
  const view = (
    <MarketSourcesProvider sources={opts.sources ?? sources({})}>
      <MarketsView
        {...(opts.now === undefined ? { nowSecs: NOW } : { nowSecs: opts.now })}
        {...(opts.tradeHref === undefined ? {} : { tradeHref: opts.tradeHref })}
      />
    </MarketSourcesProvider>
  );
  return render(
    withReader(
      reader({
        listMarkets: () => Promise.resolve(markets),
        getConfig: () =>
          Promise.resolve({
            admin: "11111111111111111111111111111111",
            paused: opts.paused ?? false,
            overrideDelaySecs: 3_600n,
          }),
      }),
      view,
    ),
  );
}

const rowFor = async (strikeText: string) =>
  (await screen.findAllByRole("row")).find((row) =>
    row.textContent?.includes(strikeText),
  ) as HTMLElement;

describe("active date scoping (AC1)", () => {
  const earlier = (n: number) => m(n, { address: addr(n + 5), tradingDate: 20261007 });

  it("shows only today's markets when today has markets, and no 'Showing markets from' line", async () => {
    renderView([m(1), earlier(2)]);
    expect(await screen.findAllByRole("row")).toHaveLength(2); // header + one strike
    expect(screen.queryByText(/Showing markets from/)).toBeNull();
  });

  it("with the clock on the earlier date, that date is today: only its markets, no 'Showing' line", async () => {
    // Two NVDA dates: Oct 7 (3 strikes) and Oct 8 (1 strike); the clock is on Oct 7 (15:00 ET).
    renderView([earlier(1), earlier(2), earlier(3), m(4)], { now: utc("2026-10-07T19:00:00Z") });
    const section = await screen.findByRole("region", { name: "NVDA" });
    expect(within(section).getAllByRole("row")).toHaveLength(4); // header + the 3 earlier strikes
    expect(within(section).getByText(/^3 strikes/)).toBeInTheDocument();
    expect(screen.queryByText(/Showing markets from/)).toBeNull();
  });

  it("with the clock on the later date, each ladder has its own strike count and ONE live marker", async () => {
    renderView([earlier(1), earlier(2), m(3), m(4), m(5)], {
      sources: sources({ prices: [{ ticker: "NVDA", price_cents: 21_142 }] }),
    });
    const section = await screen.findByRole("region", { name: "NVDA" });
    await vi.waitFor(() => expect(section).toHaveTextContent("$211.42"));
    expect(within(section).getByText(/^3 strikes/)).toBeInTheDocument(); // not 5: Oct 7 is excluded
    expect(section.querySelectorAll('[data-testid="live-marker"]')).toHaveLength(1);
    expect(within(section).getAllByRole("row")).toHaveLength(4);
  });

  it("falls back to the most recent date with a 'Showing markets from' line when today has none", async () => {
    renderView([earlier(1), earlier(2)], { now: utc("2026-10-10T15:00:00Z") }); // Saturday
    expect(await screen.findByText("Showing markets from 2026-10-07 (closed)")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("an empty reader result is the only 'No markets today'", async () => {
    renderView([]);
    expect(await screen.findByText(/No markets today/)).toBeInTheDocument();
  });
});

describe("row link (AC2)", () => {
  it("renders an anchor in the strike cell (never on the row) when tradeHref is given", async () => {
    renderView([m(1)], { tradeHref: (x) => `/trade/${x.address}` });
    const row = await rowFor("$180");
    const link = within(row).getByRole("link");
    expect(link).toHaveAttribute("href", `/trade/${addr(1)}`);
    expect(row.tagName).toBe("TR");
    expect(row.closest("a")).toBeNull();
    expect(link).toHaveClass("after:absolute", "after:inset-0");
  });

  it("renders no link and no Trade text until the Trade route exists", async () => {
    renderView([m(1)]);
    await screen.findAllByRole("row");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Trade")).toBeNull();
  });
});

describe("states (AC3): every state shows its words", () => {
  const at = async (over: Parameters<typeof market>[0], now: number, paused = false) => {
    renderView([m(1, over)], { now, paused });
    return rowFor("$180");
  };
  const C = Number(CLOSE);

  it("Open", async () => expect(await at({}, NOW)).toHaveTextContent("Open"));
  it("Closing soon counts down to the close", async () =>
    expect(await at({}, C - 724)).toHaveTextContent("Closes in 12:04"));
  it("Closed names the settling time in ET", async () =>
    expect(await at({}, C + 10)).toHaveTextContent("Closed, settling at 16:05 ET"));
  it("Settling has no attempt number", async () => {
    const row = await at({}, C + 400);
    expect(row).toHaveTextContent("Settling…");
    expect(row.textContent).not.toMatch(/attempt/);
  });
  it("Settlement delayed names the override time, then 'available now'", async () => {
    const before = await at({}, C + 1_300);
    expect(before).toHaveTextContent("an admin override opens at 17:00 ET");
    expect(before.querySelector(".mer-spin")).toBeNull();
  });
  it("Settlement delayed at and after close + override delay says available now", async () => {
    expect(await at({}, C + 3_600)).toHaveTextContent("an admin override is available now");
  });
  it("Settled YES and NO show the outcome and the floored settle price", async () => {
    const yes = await at(
      { settled: true, outcome: "Yes", settlePriceScaled: 181_426_000_000_000_000_000n },
      C + 10,
    );
    expect(yes).toHaveTextContent("Settled YES at $181.42");
  });
  it("Settled NO", async () => {
    const no = await at(
      { settled: true, outcome: "No", settlePriceScaled: 178_100_000_000_000_000_000n },
      C + 10,
    );
    expect(no).toHaveTextContent("Settled NO at $178.10");
  });
  it("Paused shows only on an otherwise Open market; Settled and Closed keep their own badge", async () => {
    expect(await at({}, NOW, true)).toHaveTextContent("Paused: trading and minting stopped");
  });
  it("paused + settled shows Settled", async () => {
    expect(await at({ settled: true }, C + 10, true)).toHaveTextContent("Settled YES at $181.00");
  });
  it("paused + closed shows Closed", async () => {
    const row = await at({}, C + 10, true);
    expect(row).toHaveTextContent("Closed, settling at 16:05 ET");
    expect(row.textContent).not.toMatch(/Paused/);
  });
});

describe("open time, close time and countdown to the next transition (D-050)", () => {
  it("shows the creation time and the close time in ET and a countdown", async () => {
    renderView([m(1)], { sources: sources({ open: { [addr(1)]: OPEN } }) });
    const row = await rowFor("$180");
    await vi.waitFor(() => expect(row).toHaveTextContent("Opened 09:00 ET · closes 16:00 ET"));
    expect(row).toHaveTextContent("Closing soon in 45:00"); // 15:00 now, closing soon at 15:45
  });

  it("an unreadable creation time shows a dash, not a made-up time", async () => {
    renderView([m(1)]);
    expect(await rowFor("$180")).toHaveTextContent("Opened — · closes 16:00 ET");
  });

  it("the ticker header says how many strikes and when they close", async () => {
    renderView([m(1), m(2)]);
    const section = await screen.findByRole("region", { name: "NVDA" });
    expect(within(section).getByText("2 strikes · closes 16:00 ET")).toBeInTheDocument();
  });
});

describe("displayed price (AC7, AC4)", () => {
  const withBook = async (bid: number | null, ask: number | null) => {
    renderView([m(1)], { sources: sources({ books: { [addr(1)]: q(bid, ask) } }) });
    await vi.waitFor(async () =>
      expect((await rowFor("$180")).textContent).toMatch(/\d+¢ (YES|NO)/),
    );
    return rowFor("$180");
  };

  it("midpoint with a derived NO and a probability when the spread is 10c or less", async () => {
    const row = await withBook(50, 60);
    expect(row).toHaveTextContent("55¢ YES · 55%");
    expect(row).toHaveTextContent("45¢ NO");
    expect(within(row).getByTestId("bar-fill")).toHaveStyle({ width: "55%" });
    expect(row).not.toHaveTextContent("wide spread");
  });

  it("a bid and ask range, 'wide spread', the NO range, no probability and an outlined bar at 11c", async () => {
    const row = await withBook(50, 61);
    expect(row).toHaveTextContent("50–61¢ YES");
    expect(row).toHaveTextContent("wide spread");
    expect(row).toHaveTextContent("39–50¢ NO");
    expect(row.textContent).not.toMatch(/%/);
    expect(within(row).queryByTestId("bar-fill")).toBeNull();
    expect(within(row).getByTestId("bar-range")).toBeInTheDocument();
  });

  it("a one-sided book is a range with only the derived side", async () => {
    const row = await withBook(40, null);
    expect(row).toHaveTextContent("40¢ YES");
    expect(row).toHaveTextContent("60¢ NO");
    expect(row.textContent).not.toMatch(/%/);
  });

  it("no live book shows a dash, never a number", async () => {
    renderView([m(1)]);
    const row = await rowFor("$180");
    expect(row.textContent).not.toMatch(/\d+¢ (YES|NO)/);
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("every row says NO is derived", async () => {
    renderView([m(1)]);
    expect(await rowFor("$180")).toHaveTextContent("NO is 100 − YES; YES + NO = 100¢");
  });
});

describe("page notes and landing (AC7)", () => {
  it("the midpoint warning is always-visible text in the document, with no hover or focus", async () => {
    renderView([m(1)]);
    expect(await screen.findByText(MIDPOINT_NOTE)).toBeVisible();
    expect(screen.getAllByText(MIDPOINT_NOTE)).toHaveLength(1);
  });

  it("the 'closed does not mean settled' help appears once, only while a Closed, Settling or delayed market exists", async () => {
    const closed = renderView([m(1), m(2)], { now: Number(CLOSE) + 10 });
    expect(await screen.findAllByText(SETTLE_NOTE)).toHaveLength(1);
    closed.unmount();
    renderView([m(1)]);
    await screen.findAllByRole("row");
    expect(screen.queryByText(SETTLE_NOTE)).toBeNull();
  });

  it("never puts the help text inside a badge or a row", async () => {
    renderView([m(1)], { now: Number(CLOSE) + 10 });
    const row = await rowFor("$180");
    expect(row.textContent).not.toContain("closed does not mean settled");
  });

  it("the landing says what connecting does and hides once a wallet is connected", async () => {
    wallet.publicKey = null;
    const first = renderView([m(1)]);
    expect(await screen.findByText(CONNECT_COPY)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
    first.unmount();
    wallet.publicKey = { toBase58: () => "x" };
    renderView([m(1)]);
    await screen.findAllByRole("row");
    expect(screen.queryByText(CONNECT_COPY)).toBeNull();
    wallet.publicKey = null;
  });
});

describe("live price (header line)", () => {
  it("shows the live price with its as-of time and puts one decorative marker between the two strikes", async () => {
    renderView([m(1), m(2), m(3)], {
      sources: sources({ prices: [{ ticker: "NVDA", price_cents: 18_142 }] }),
    });
    const section = await screen.findByRole("region", { name: "NVDA" });
    await vi.waitFor(() => expect(section).toHaveTextContent("$181.42"));
    expect(section).toHaveTextContent(/as of \d\d:\d\d:\d\d ET/);
    const markers = section.querySelectorAll('[data-testid="live-marker"]');
    expect(markers).toHaveLength(1); // strikes 180 (n=1), 190 (n=2): $181.42 sits below the 190 strike
    expect(markers[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(within(section).getAllByRole("row")).toHaveLength(4); // header + 3, the marker is not a row
  });

  it("says the price is not live yet when there is none, and keeps the heading to the symbol", async () => {
    renderView([m(1)]);
    const section = await screen.findByRole("region", { name: "NVDA" });
    expect(section).toHaveTextContent("price not live yet");
    expect(within(section).getByRole("heading", { level: 2 })).toHaveTextContent(/^NVDA$/);
  });
});
