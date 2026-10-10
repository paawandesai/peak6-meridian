import { expect, test } from "./support/fixtures";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

test("Markets lists a ladder per ticker with strike rows from the seeded chain", async ({
  page,
}) => {
  await page.goto("/");
  for (const ticker of MAG7) {
    const ladder = page.getByRole("region", { name: ticker });
    await expect(ladder).toBeVisible();
    // Seven strikes per ticker at most, at least the 0% strike (the previous close).
    expect(await ladder.getByRole("row").count()).toBeGreaterThan(1);
  }
  // META's previous close is $680.00, so its 0% strike is $680 (tests/fixtures/prev_closes.json).
  await expect(page.getByRole("region", { name: "META" })).toContainText("680");
});

test("the header shows the ET clock and the next close", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("et-clock")).toContainText(/\d\d:\d\d:\d\d ET/);
  await expect(page.getByTestId("next-close")).not.toContainText("--:--");
});
