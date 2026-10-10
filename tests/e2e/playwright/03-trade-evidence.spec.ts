/**
 * Evidence collection for M2-06 AC5 and UI-04 AC5-AC6 (issue #45).
 * Captures screenshots and timing for the four trade intents, validates 390px viewport.
 * Run via CI to produce artifacts attached to #45.
 */
import {
  type Chain,
  fundMaker,
  makerOrder,
  openChain,
  seededMarket,
  tokenBalance,
  tokenAccounts,
} from "./support/chain";
import { expect, test } from "./support/fixtures";
import { connectionFor } from "./support/state";
import { connectWallet } from "./support/wallet";
import {
  confirmedStatus,
  intentButton,
  type IntentLabel,
  priceInput,
  qtyInput,
  signButton,
  tradePath,
} from "./support/ui";

const META_STRIKE_CENTS = 68_000n;

type Step = {
  readonly intent: IntentLabel;
  readonly qty: number;
  /** Price in cents of the side being traded (YES price for YES intents, NO price for NO). */
  readonly priceCents: number;
  /** The maker order that gives the wallet something to trade against. */
  readonly maker: Parameters<typeof makerOrder>[3];
  /** Net change of the wallet's YES and NO token balances. */
  readonly yesDelta: bigint;
  readonly noDelta: bigint;
};

const STEPS: readonly Step[] = [
  {
    intent: "Buy YES",
    qty: 5,
    priceCents: 60,
    maker: { intent: "SELL_YES", kind: "limit", priceCents: 60, qty: 5n },
    yesDelta: 5n,
    noDelta: 0n,
  },
  {
    intent: "Sell YES",
    qty: 5,
    priceCents: 55,
    maker: { intent: "BUY_YES", kind: "limit", priceCents: 55, qty: 5n },
    yesDelta: -5n,
    noDelta: 0n,
  },
  {
    intent: "Buy NO",
    qty: 3,
    priceCents: 55,
    maker: { intent: "BUY_YES", kind: "limit", priceCents: 45, qty: 3n },
    yesDelta: 0n,
    noDelta: 3n,
  },
  {
    intent: "Sell NO",
    qty: 1,
    priceCents: 30,
    maker: { intent: "SELL_YES", kind: "limit", priceCents: 70, qty: 1n },
    yesDelta: 0n,
    noDelta: -1n,
  },
];

test.describe("Trade evidence collection (M2-06 AC5, UI-04 AC5-AC6)", () => {
  test("four intents with screenshots and timing (< 3s each)", async ({ page, state, wallet }) => {
    const connection = connectionFor(state);
    const chain: Chain = openChain(state, connection);
    const market = seededMarket(chain, state, "META", META_STRIKE_CENTS);
    const mine = await tokenAccounts(chain, state, wallet.keypair.publicKey, market);
    const maker = await fundMaker(chain, state, market, 20n);

    await page.goto(tradePath(market.market.toBase58()));
    await connectWallet(page, wallet.keypair.publicKey.toBase58());

    const timings: Array<{ intent: string; durationMs: number }> = [];

    for (const step of STEPS) {
      const yesBefore = await tokenBalance(connection, mine.yes);
      const noBefore = await tokenBalance(connection, mine.no);
      await makerOrder(chain, market, maker, step.maker);

      await intentButton(page, step.intent).click();
      await priceInput(page).fill(String(step.priceCents));
      await qtyInput(page).fill(String(step.qty));

      // Capture before screenshot
      await page.screenshot({
        path: `playwright-report/evidence/${step.intent.replace(" ", "-").toLowerCase()}-before.png`,
        fullPage: true,
      });

      wallet.reset();
      const startTime = Date.now();
      await signButton(page).click();
      await expect(confirmedStatus(page)).toBeVisible();
      const endTime = Date.now();
      const durationMs = endTime - startTime;

      // Capture after screenshot
      await page.screenshot({
        path: `playwright-report/evidence/${step.intent.replace(" ", "-").toLowerCase()}-after.png`,
        fullPage: true,
      });

      // Record timing
      timings.push({ intent: step.intent, durationMs });

      // UI-04 AC5: confirmation must be < 3s
      expect(
        durationMs,
        `${step.intent} confirmation time ${durationMs}ms exceeds 3s limit`,
      ).toBeLessThan(3000);

      // Verify balances changed correctly
      expect(wallet.requests(), `${step.intent}: signature requests`).toBe(1);
      expect(await tokenBalance(connection, mine.yes)).toBe(yesBefore + step.yesDelta);
      expect(await tokenBalance(connection, mine.no)).toBe(noBefore + step.noDelta);
    }

    // Write timing summary
    console.log("=== Trade Confirmation Timings ===");
    for (const { intent, durationMs } of timings) {
      console.log(`${intent}: ${durationMs}ms`);
    }
    console.log(
      `Average: ${Math.round(timings.reduce((sum, t) => sum + t.durationMs, 0) / timings.length)}ms`,
    );
  });

  test("390px viewport validation (UI-04 AC6)", async ({ page, state, wallet }) => {
    // Set viewport to 390px width (mobile)
    await page.setViewportSize({ width: 390, height: 844 });

    const connection = connectionFor(state);
    const chain: Chain = openChain(state, connection);
    const market = seededMarket(chain, state, "META", META_STRIKE_CENTS);
    await fundMaker(chain, state, market, 10n);

    await page.goto(tradePath(market.market.toBase58()));
    await connectWallet(page, wallet.keypair.publicKey.toBase58());

    // Verify all trade UI elements are visible and accessible at 390px
    await expect(intentButton(page, "Buy YES")).toBeVisible();
    await expect(intentButton(page, "Buy NO")).toBeVisible();
    await expect(intentButton(page, "Sell YES")).toBeVisible();
    await expect(intentButton(page, "Sell NO")).toBeVisible();
    await expect(priceInput(page)).toBeVisible();
    await expect(qtyInput(page)).toBeVisible();

    // Click Buy YES and verify sign button is visible
    await intentButton(page, "Buy YES").click();
    await priceInput(page).fill("60");
    await qtyInput(page).fill("1");
    await expect(signButton(page)).toBeVisible();

    // Capture 390px viewport screenshot
    await page.screenshot({
      path: "playwright-report/evidence/viewport-390px.png",
      fullPage: true,
    });
  });
});
