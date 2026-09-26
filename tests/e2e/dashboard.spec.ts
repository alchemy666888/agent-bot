import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DASHBOARD_SECRET, E2E_ROOT } from "./constants";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Administrator secret").fill(DASHBOARD_SECRET);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

async function expectNoHorizontalScroll(page: Page) {
  const metrics = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1);
}

test("rejects unauthenticated and invalid dashboard access", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Administrator secret").fill("wrong-secret");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toHaveCount(0);
});

test("inspects every read-only dashboard view", async ({ page }) => {
  await signIn(page);
  const session = (await page.context().cookies()).find((cookie) =>
    cookie.name.startsWith("__Host-"),
  );
  expect(session).toBeTruthy();
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([{ ...session!, value: `${session!.value}tampered` }]);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page);
  await expect(page.getByText("51", { exact: true })).toBeVisible();
  const response = await page.goto("/dashboard/users");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  expect(response?.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  await page.getByLabel("Search users").fill("needle");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Needle")).toBeVisible();
  await expect(page.getByText("user-0")).toHaveCount(0);
  await page.goto("/dashboard/users");
  await page.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator(".records li")).toHaveCount(1);
  await page.getByRole("link", { name: "Previous page" }).click();
  await expect(page).not.toHaveURL(/page=2/);

  await page.getByRole("link", { name: "Conversations" }).click();
  await page.getByRole("link", { name: "Open conversation" }).click();
  await expect(page.getByText("Hello from history")).toBeVisible();
  await page.getByRole("link", { name: "Messages" }).click();
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
  await page.getByRole("link", { name: "Usage" }).click();
  await expect(page.getByText("0.000008")).toBeVisible();
  await expect(page.getByText("Unavailable").first()).toBeVisible();
  await page.getByRole("link", { name: "Errors" }).click();
  await expect(page.getByText("PROVIDER_FAILED")).toBeVisible();

  const buttons = (await page.getByRole("button").allTextContents()).join(" ");
  expect(buttons).not.toMatch(/delete|edit|save/i);
  await expect(page.getByRole("link", { name: "Refresh" })).toBeVisible();

  await page.goto("/dashboard/users?search=RefreshedUser");
  await expect(page.getByText("RefreshedUser")).toHaveCount(0);
  await writeFile(
    join(E2E_ROOT, "data/state/users/refreshed.json"),
    JSON.stringify({
      telegramUserId: "4242",
      username: "RefreshedUser",
    }),
  );
  await expect(page.getByText("RefreshedUser")).toHaveCount(0);
  await page.getByRole("link", { name: "Refresh" }).click();
  await expect(page.getByText("RefreshedUser")).toBeVisible();

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    for (const path of [
      "/dashboard",
      "/dashboard/users",
      "/dashboard/conversations",
      "/dashboard/conversations/conv-1",
      "/dashboard/messages",
      "/dashboard/model-runs",
      "/dashboard/errors",
    ]) {
      await page.goto(path);
      await expectNoHorizontalScroll(page);
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    }
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/dashboard");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement ?? document.body);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
  expect(outline).not.toContain("none");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download data" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^telegram-agent-data-.*\.zip$/);

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
});

test("downloads an archive with one bearer credential", async ({ request }) => {
  const authorized = await request.get("/api/download", {
    headers: { authorization: `Bearer ${DASHBOARD_SECRET}` },
  });
  expect(authorized.status()).toBe(200);
  expect(authorized.headers()["content-type"]).toContain("application/zip");
  expect(authorized.headers()["cache-control"]).toContain("no-store");
  expect(
    Buffer.from(await authorized.body())
      .subarray(0, 2)
      .toString(),
  ).toBe("PK");
  const rejected = await request.get("/api/download", {
    headers: { authorization: `Bearer wrong, Bearer ${DASHBOARD_SECRET}` },
  });
  expect(rejected.status()).toBe(401);
  const missing = await request.get("/api/download");
  expect(missing.status()).toBe(401);
});
