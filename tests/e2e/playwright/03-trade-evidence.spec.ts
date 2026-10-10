/**
 * Evidence for M2-06 AC5 and UI-04 AC5-AC6 (issue #45), on a local validator.
 *
 * The four intents (Buy YES market, Sell YES limit, Buy NO market, Sell NO at a limit price) run
 * through the real Trade page at 390 px with the injected test wallet: before/after screenshots,
 * click -> "Confirmed in slot" and click -> book updated timings (each < 3 s), and a 390 px
 * no-horizontal-scroll check. With E2E_LIGHTHOUSE=1 it also runs a one-off Lighthouse
 * accessibility audit of the same Trade page (mobile and desktop).
 *
 * Run (production bundle): `E2E_APP_MODE=production pnpm --filter e2e run test:evidence`.
 * Output: tests/e2e/evidence/i45/ (screenshots, timings.json, timings.md, Lighthouse reports).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Page } from "@playwright/test";
import { z } from "zod";

import {
  type Chain,
  createSessionMarket,
  fundMaker,
  fundUsdc,
  makerOrder,
  openChain,
  tokenAccounts,
  tokenBalance,
} from "./support/chain";
import { expect, test } from "./support/fixtures";
import { connectionFor, type StackState } from "./support/state";
import { connectWallet } from "./support/wallet";
import {
  confirmedStatus,
  intentButton,
  type IntentLabel,
  orderKindRadio,
  priceInput,
  qtyInput,
  signButton,
  tradePath,
} from "./support/ui";

const EVIDENCE_DIR =
  process.env.E2E_EVIDENCE_DIR ??
  resolve(fileURLToPath(new URL(".", import.meta.url)), "../evidence/i45");
/** META's previous close; the session ladder always contains this strike ($680). */
const META_PREV_CLOSE_CENTS = 68_000;
/** NFR-01 / UI-04 AC6: a confirmed trade shows within 3 s. */
const BUDGET_MS = 3_000;
/** The Lighthouse version !142 used for its Trade audit. */
const LIGHTHOUSE = "lighthouse@12.8.2";
const MOBILE = { width: 390, height: 844 } as const;

type Step = {
  /** File slug and table label. */
  readonly slug: string;
  readonly label: string;
  readonly intent: IntentLabel;
  /** The UI order-type radio. Sell NO is IOC-only (domain.md), so its limit is the worst price. */
  readonly kind: "market" | "limit";
  readonly qty: number;
  /** Price in cents of the side being traded (YES price for YES intents, NO price for NO). */
  readonly priceCents: number;
  /** The resting maker order the wallet trades against. */
  readonly maker: Parameters<typeof makerOrder>[3];
  /** Net change of the wallet's YES and NO token balances. */
  readonly yesDelta: bigint;
  readonly noDelta: bigint;
};

const STEPS: readonly Step[] = [
  {
    slug: "buy-yes-market",
    label: "Buy YES, market (worst 60¢)",
    intent: "Buy YES",
    kind: "market",
    qty: 5,
    priceCents: 60,
    maker: { intent: "SELL_YES", kind: "limit", priceCents: 60, qty: 5n },
    yesDelta: 5n,
    noDelta: 0n,
  },
  {
    slug: "sell-yes-limit",
    label: "Sell YES, limit 55¢",
    intent: "Sell YES",
    kind: "limit",
    qty: 5,
    priceCents: 55,
    maker: { intent: "BUY_YES", kind: "limit", priceCents: 55, qty: 5n },
    yesDelta: -5n,
    noDelta: 0n,
  },
  {
    slug: "buy-no-market",
    label: "Buy NO, market (worst 55¢)",
    intent: "Buy NO",
    kind: "market",
    qty: 3,
    priceCents: 55,
    maker: { intent: "BUY_YES", kind: "limit", priceCents: 45, qty: 3n },
    yesDelta: 0n,
    noDelta: 3n,
  },
  {
    slug: "sell-no-limit",
    label: "Sell NO, limit 30¢ (IOC at a limit price)",
    intent: "Sell NO",
    kind: "market",
    qty: 1,
    priceCents: 30,
    maker: { intent: "SELL_YES", kind: "limit", priceCents: 70, qty: 1n },
    yesDelta: 0n,
    noDelta: -1n,
  },
];

type Timing = {
  readonly intent: string;
  readonly slot: number;
  readonly confirmMs: number;
  readonly bookMs: number;
  readonly signatureRequests: number;
};

const bookTable = (page: Page) => page.getByTestId("book-table");

/** Resolves with ms since `t0` once the book table's text differs from `before`. */
async function bookChangedAfter(page: Page, before: string, t0: number): Promise<number> {
  await page.waitForFunction(
    (prev) => document.querySelector('[data-testid="book-table"]')?.textContent !== prev,
    before,
    { polling: 50, timeout: 20_000 },
  );
  return Date.now() - t0;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

function writeTimings(timings: readonly Timing[], state: StackState, market: string): void {
  const lines = [
    "| Intent | Slot | Click -> Confirmed (ms) | Click -> book updated (ms) | Signature requests | < 3 s |",
    "|---|---|---|---|---|---|",
    ...timings.map(
      (t) =>
        `| ${t.intent} | ${t.slot} | ${t.confirmMs} | ${t.bookMs} | ${t.signatureRequests} | ${
          Math.max(t.confirmMs, t.bookMs) < BUDGET_MS ? "yes" : "NO"
        } |`,
    ),
  ];
  const meta = {
    recordedAt: new Date().toISOString(),
    appMode: process.env.E2E_APP_MODE === "production" ? "production" : "dev",
    viewport: MOBILE,
    rpcUrl: state.rpcUrl,
    programId: state.programId,
    market,
    budgetMs: BUDGET_MS,
  };
  writeFileSync(join(EVIDENCE_DIR, "timings.json"), JSON.stringify({ ...meta, timings }, null, 2));
  writeFileSync(join(EVIDENCE_DIR, "timings.md"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

test.describe.configure({ mode: "serial" });
test.use({ viewport: MOBILE });

test.describe("Trade evidence (M2-06 AC5, UI-04 AC5-AC6, #45)", () => {
  test.beforeAll(() => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
  });

  test("four intents from the UI at 390 px, each confirmed and in the book < 3 s", async ({
    page,
    state,
    wallet,
  }) => {
    test.setTimeout(300_000);
    const connection = connectionFor(state);
    const chain: Chain = openChain(state, connection);
    const { market } = createSessionMarket(chain, state, "META", META_PREV_CLOSE_CENTS);
    const mine = await tokenAccounts(chain, state, wallet.keypair.publicKey, market);
    await fundUsdc(chain, state, mine.usdc, 1_000n);
    const maker = await fundMaker(chain, state, market, 20n);

    await page.goto(tradePath(market.market.toBase58()));
    await connectWallet(page, wallet.keypair.publicKey.toBase58());
    await expect(bookTable(page)).toBeVisible();

    const timings: Timing[] = [];
    for (const step of STEPS) {
      const yesBefore = await tokenBalance(connection, mine.yes);
      const noBefore = await tokenBalance(connection, mine.no);

      // Rest the maker order, then wait for the page's 1 s book poll to show it.
      const emptyBook = (await bookTable(page).textContent()) ?? "";
      await makerOrder(chain, market, maker, step.maker);
      await bookChangedAfter(page, emptyBook, Date.now());

      await intentButton(page, step.intent).click();
      await orderKindRadio(page, step.kind).check();
      await priceInput(page).fill(String(step.priceCents));
      await qtyInput(page).fill(String(step.qty));
      await expect(signButton(page)).toBeEnabled();
      await shot(page, `${step.slug}-before`);

      const bookBefore = (await bookTable(page).textContent()) ?? "";
      wallet.reset();
      const t0 = Date.now();
      await signButton(page).click();
      await expect(confirmedStatus(page)).toBeVisible();
      const confirmMs = Date.now() - t0;
      const bookMs = await bookChangedAfter(page, bookBefore, t0);
      const slotText = (await confirmedStatus(page).textContent()) ?? "";
      await shot(page, `${step.slug}-after`);

      timings.push({
        intent: step.label,
        slot: Number(/slot (\d+)/.exec(slotText)?.[1] ?? "0"),
        confirmMs,
        bookMs,
        signatureRequests: wallet.requests(),
      });

      expect(wallet.requests(), `${step.intent}: signature requests`).toBe(1);
      expect(await tokenBalance(connection, mine.yes)).toBe(yesBefore + step.yesDelta);
      expect(await tokenBalance(connection, mine.no)).toBe(noBefore + step.noDelta);
    }

    writeTimings(timings, state, market.market.toBase58());
    for (const t of timings) {
      expect(t.confirmMs, `${t.intent}: click -> Confirmed`).toBeLessThan(BUDGET_MS);
      expect(t.bookMs, `${t.intent}: click -> book updated`).toBeLessThan(BUDGET_MS);
    }
  });

  test("390 px: every Trade control is visible and nothing scrolls sideways", async ({
    page,
    state,
    wallet,
  }) => {
    const chain = openChain(state, connectionFor(state));
    const { market } = createSessionMarket(chain, state, "META", META_PREV_CLOSE_CENTS);
    await page.goto(tradePath(market.market.toBase58()));
    await connectWallet(page, wallet.keypair.publicKey.toBase58());

    for (const intent of ["Buy YES", "Buy NO", "Sell YES", "Sell NO"] as const) {
      await expect(intentButton(page, intent)).toBeVisible();
    }
    // The wallet holds NO after the four-intent run, so Buy YES is blocked (position constraint).
    await intentButton(page, "Buy NO").click();
    await expect(priceInput(page)).toBeVisible();
    await expect(qtyInput(page)).toBeVisible();
    await expect(signButton(page)).toBeVisible();
    await expect(bookTable(page)).toBeVisible();
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.client).toBe(MOBILE.width);
    expect(widths.scroll, "horizontal overflow at 390 px").toBeLessThanOrEqual(widths.client);
    writeFileSync(join(EVIDENCE_DIR, "viewport-390.json"), JSON.stringify(widths, null, 2));
    await shot(page, "viewport-390");
  });

  test("Lighthouse accessibility >= 90 on Trade (mobile and desktop)", async ({ state }) => {
    test.skip(process.env.E2E_LIGHTHOUSE !== "1", "set E2E_LIGHTHOUSE=1 to run Lighthouse");
    test.setTimeout(600_000);
    const chain = openChain(state, connectionFor(state));
    const { market } = createSessionMarket(chain, state, "META", META_PREV_CLOSE_CENTS);
    const url = `${state.appUrl}${tradePath(market.market.toBase58())}`;
    const report = z.object({
      lighthouseVersion: z.string(),
      categories: z.object({ accessibility: z.object({ score: z.number() }) }),
    });
    const scores: Record<string, number> = {};
    for (const formFactor of ["mobile", "desktop"] as const) {
      const base = join(EVIDENCE_DIR, `lighthouse-trade-${formFactor}`);
      execFileSync(
        "npx",
        [
          "--yes",
          LIGHTHOUSE,
          url,
          "--only-categories=accessibility",
          "--pause-after-load-ms=15000",
          "--output=json",
          "--output=html",
          `--output-path=${base}`,
          `--chrome-path=${chromium.executablePath()}`,
          "--chrome-flags=--headless=new --no-sandbox",
          "--quiet",
          ...(formFactor === "desktop" ? ["--preset=desktop"] : []),
        ],
        { stdio: "inherit", timeout: 240_000 },
      );
      const parsed = report.parse(JSON.parse(readFileSync(`${base}.report.json`, "utf8")));
      scores[formFactor] = Math.round(parsed.categories.accessibility.score * 100);
      console.log(`Lighthouse ${parsed.lighthouseVersion} ${formFactor}: ${scores[formFactor]}`);
    }
    writeFileSync(
      join(EVIDENCE_DIR, "lighthouse-summary.json"),
      JSON.stringify({ url, lighthouse: LIGHTHOUSE, accessibility: scores }, null, 2),
    );
    for (const [formFactor, score] of Object.entries(scores)) {
      expect(score, `${formFactor} accessibility`).toBeGreaterThanOrEqual(90);
    }
  });
});
