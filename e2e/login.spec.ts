import { test, expect } from "@playwright/test";

import { login } from "./helpers";

test("unauthenticated user is redirected to login for project routes", async ({ page }) => {
  await page.goto("/default");
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 15_000 });
  await expect(page.locator('input[name="email"]')).toBeVisible();
});

test("login flow — seeded user signs in and lands on dashboard", async ({ page }) => {
  await page.goto("/login");

  // Verify login page rendered
  await expect(page.locator("h1")).toHaveText("Taskito");

  await login(page);

  // Assert we're on a dashboard project slug route.
  const url = new URL(page.url());
  expect(url.pathname).toMatch(/^\/[^/]+$/);
  expect(["/login", "/no-access", "/settings"]).not.toContain(url.pathname);
});

test("logged-in user can log out back to login", async ({ page }) => {
  await login(page);

  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL("**/login", { timeout: 15_000 });
  await expect(page.locator('input[name="email"]')).toBeVisible();
});
