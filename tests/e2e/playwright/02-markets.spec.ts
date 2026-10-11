import { expect, test } from "./support/fixtures";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

test("the Trade board shows a tile per ticker with strike rows from the seeded chain", async ({
  page,
}) => {
  await page.goto("/");
  for (const ticker of MAG7) {
    const tile = page.getByRole("region", { name: ticker });
    await expect(tile).toBeVisible();
    // One header row plus at most five strikes (docs/redesign-spec.md §2.2).
    const rows = await tile.getByRole("row").count();
    expect(rows).toBeGreaterThan(1);
    expect(rows).toBeLessThanOrEqual(6);
  }
  // META's previous close is $680.00, so its 0% strike is $680 (tests/fixtures/prev_closes.json).
  await expect(page.getByRole("region", { name: "META" })).toContainText("680");
  // The ladders above are the session markets global-setup creates; the lifecycle seed's
  // `--close-in-secs` markets stay behind the test-market toggle (P0-1), never mixed in.
  await expect(page.getByTestId("test-market-toggle")).toHaveText(/^Show test markets \(\d+\)$/);
});

test("the header shows the ET clock and the next close", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("et-clock")).toContainText(/\d\d:\d\d:\d\d ET/);
  await expect(page.getByTestId("next-close")).not.toContainText("--:--");
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  test(`the board has no horizontal scroll at ${viewport.width} px (AC12)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("region", { name: "META" })).toContainText("680");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("a tile opens the detail view, which Close dismisses back to the tile (AC9, AC10)", async ({
  page,
}) => {
  await page.goto("/");
  const button = page
    .getByRole("region", { name: "NVDA" })
    .getByRole("button", { name: "NVDA", exact: true });
  await button.click();
  await expect(page).toHaveURL(/[?&]t=NVDA/);
  const detail = page.getByTestId("detail-view");
  await expect(detail.getByRole("heading", { level: 2, name: "NVDA" })).toBeFocused();
  await expect(detail.getByRole("link", { name: /Trade this strike/ })).toHaveAttribute(
    "href",
    /^\/trade\/[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  );
  await detail.getByRole("button", { name: "Close" }).click();
  await expect(detail).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]t=/);
  await expect(button).toBeFocused();
});
