/**
 * Portfolio shows the positions the trade spec created. Written against design.md v2 §5 Portfolio
 * and M2-07 (!43).
 */
import { openChain, seededMarket, tokenAccounts, tokenBalance } from "./support/chain";
import { expect, test } from "./support/fixtures";
import { connectionFor } from "./support/state";
import { connectWallet } from "./support/wallet";

test("Portfolio lists the wallet's META positions with the on-chain quantities", async ({
  page,
  state,
  wallet,
}) => {
  const connection = connectionFor(state);
  const chain = openChain(state, connection);
  const market = seededMarket(chain, state, "META", 68_000n);
  const mine = await tokenAccounts(chain, state, wallet.keypair.publicKey, market);
  const yes = await tokenBalance(connection, mine.yes);
  const no = await tokenBalance(connection, mine.no);
  expect(yes + no, "03-trade should have left positions").toBeGreaterThan(0n);

  await page.goto("/portfolio");
  await connectWallet(page, wallet.keypair.publicKey.toBase58());

  // The totals line answers "where do I stand" first (design.md §5 Portfolio (a)).
  // Scoped to the page body: the header also shows the balance and the "Get test-USDC" button.
  await expect(page.getByRole("main").getByText(/test-USDC/)).toBeVisible();
  await expect(page.getByText(/Redeemable now/i)).toBeVisible();

  // One row per held side, with the quantity from the chain and the market's strike.
  const rows = page.getByRole("row").filter({ hasText: "META" });
  if (yes > 0n) {
    await expect(rows.filter({ hasText: "YES" }).first()).toContainText(String(yes));
  }
  if (no > 0n) {
    await expect(rows.filter({ hasText: "NO" }).first()).toContainText(String(no));
  }
  await expect(
    page.getByText(/Mark is the book midpoint, not a guaranteed sale price/i),
  ).toBeVisible();
});
