import { test, expect } from "@playwright/test";

test("login flow — seeded user signs in and lands on dashboard", async ({ page }) => {
  // Navigate to /login
  await page.goto("/login");

  // Verify login page rendered
  await expect(page.locator("h1")).toHaveText("Taskito");

  // Fill in the seeded credentials
  await page.fill('input[name="email"]', "admin@taskito.local");
  await page.fill('input[name="password"]', "taskito-demo-2026");

  // Submit the form
  await page.click('button[type="submit"]');

  // Wait for navigation away from /login — should land on dashboard (/default)
  await page.waitForURL("**/default", {
    timeout: 15_000,
  });

  // Assert we're on the dashboard (project slug route)
  expect(page.url()).toContain("/default");
});
