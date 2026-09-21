import { expect, test } from "@playwright/test";

test("renders the application baseline", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Telegram Agent" }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/baseline.png", fullPage: true });
});
