import { connectWallet } from "./support/wallet";
import { usdcBalance } from "./support/chain";
import { expect, test } from "./support/fixtures";
import { connectionFor } from "./support/state";

test("connect the injected wallet and claim test-USDC from the faucet", async ({
  page,
  state,
  wallet,
}) => {
  const connection = connectionFor(state);
  expect(await usdcBalance(connection, state, wallet.keypair.publicKey)).toBe(0n);

  await page.goto("/");
  // Connecting asks for no signature (design.md: connecting moves nothing).
  await connectWallet(page, wallet.keypair.publicKey.toBase58());
  expect(wallet.requests()).toBe(0);

  await page.getByRole("button", { name: "Get test-USDC" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Received .*test-USDC/ })).toContainText(
    "1,000.00 test-USDC",
  );
  // The faucet mints server-side: no wallet prompt.
  expect(wallet.requests()).toBe(0);
  await expect
    .poll(() => usdcBalance(connection, state, wallet.keypair.publicKey))
    .toBe(1_000_000_000n);

  // The header balance reads the same amount after a reload.
  await page.reload();
  await expect(page.getByText("1,000.00 test-USDC")).toBeVisible();
});

test("a second claim inside 24 h is refused with the rule stated", async ({
  page,
  state,
  wallet,
}) => {
  await page.goto("/");
  await connectWallet(page, wallet.keypair.publicKey.toBase58());
  await page.getByRole("button", { name: "Get test-USDC" }).click();
  await expect(page.getByRole("alert")).toContainText(/24/);
  await expect
    .poll(() => usdcBalance(connectionFor(state), state, wallet.keypair.publicKey))
    .toBe(1_000_000_000n);
});
