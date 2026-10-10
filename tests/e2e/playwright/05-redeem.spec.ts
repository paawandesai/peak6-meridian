/**
 * Redeem after local settlement: a META strike that closes ~40 s after creation is minted by the
 * wallet, settled YES with the local oracle ($2,000 against a strike of about $1,360), and the
 * winner redeemed from Portfolio with one signature. Pays $1.00 per YES token (M2-07 AC2).
 * TODO(!43 M2-07): remove `fixme` once !43 /portfolio merges to main, check support/ui.ts.
 */
import {
  createShortMarket,
  mintPairs,
  openChain,
  settleLocally,
  tokenAccounts,
  tokenBalance,
  usdcBalance,
  waitForClose,
} from "./support/chain";
import { expect, test } from "./support/fixtures";
import { connectionFor } from "./support/state";
import { redeemButton } from "./support/ui";
import { connectWallet } from "./support/wallet";

const PAIRS = 10n;
const USDC_PER_PAIR = 1_000_000n;

test("a settled winner redeems at $1.00 each with one signature", async ({
  page,
  state,
  wallet,
}) => {
  test.setTimeout(240_000);
  const connection = connectionFor(state);
  const chain = openChain(state, connection);
  const { market, closeTs } = await createShortMarket(chain, state, 40);
  const mine = await tokenAccounts(chain, state, wallet.keypair.publicKey, market);
  await mintPairs(chain, market, wallet.keypair, mine, PAIRS);
  await waitForClose(connection, closeTs);
  await settleLocally(chain, market, "META", 200_000n);

  const before = await usdcBalance(connection, state, wallet.keypair.publicKey);
  await page.goto("/portfolio");
  await connectWallet(page, wallet.keypair.publicKey.toBase58());
  await expect(page.getByText(/Settled YES/).first()).toBeVisible();

  wallet.reset();
  await redeemButton(page).first().click();
  await expect(page.getByText(/redeemed|confirmed/i).first()).toBeVisible();

  expect(wallet.requests(), "redeem: signature requests").toBe(1);
  // YES wins: PAIRS winners pay $1.00 each; the NO tokens pay nothing.
  await expect
    .poll(() => usdcBalance(connection, state, wallet.keypair.publicKey))
    .toBe(before + PAIRS * USDC_PER_PAIR);
  expect(await tokenBalance(connection, mine.yes)).toBe(0n);
});
