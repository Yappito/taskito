import { test, expect, Page } from "@playwright/test";

import { login } from "./helpers";

test.describe("Settings page", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("settings page loads without error", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Should see the Settings heading
    await expect(page.locator("h1")).toHaveText("Settings");

    // Should have Projects and Users tabs
    await expect(page.getByRole("tab", { name: "projects" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "users" })).toBeVisible();
  });

  test("projects tab shows existing projects", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "projects" }).click();

    await expect(page.getByRole("button", { name: "New Project" })).toBeVisible();

    // Should show at least one project (the seeded "Default Project")
    await expect(page.getByText("Default Project").first()).toBeVisible();
  });

  test("can open create project dialog", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "projects" }).click();

    await page.getByRole("button", { name: "New Project" }).click();

    // Dialog should appear with form fields
    await expect(page.getByText("Create Project")).toBeVisible();
    await expect(page.locator('input[placeholder="My Project"]')).toBeVisible();
    await expect(page.locator('input[placeholder="my-project"]')).toBeVisible();
    await expect(page.locator('input[placeholder="PROJ"]')).toBeVisible();
  });

  test("create project auto-generates slug and key", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "projects" }).click();

    await page.getByRole("button", { name: "New Project" }).click();
    await page.waitForTimeout(300);

    // Type a project name
    await page.locator('input[placeholder="My Project"]').fill("Test Project");
    await page.waitForTimeout(100);

    // Slug and key should be auto-populated
    const slugInput = page.locator('input[placeholder="my-project"]');
    const keyInput = page.locator('input[placeholder="PROJ"]');
    await expect(slugInput).toHaveValue("test-project");
    await expect(keyInput).toHaveValue("TESTP");
  });

  test("project switcher navigates between projects and scopes tasks", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "projects" }).click();

    await page.getByRole("button", { name: "New Project" }).click();
    await page.waitForTimeout(300);

    await page.locator('input[placeholder="My Project"]').fill("Switcher Project");
    await page.locator('input[placeholder="Optional description"]').fill("Used for project switching coverage");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText("Switcher Project")).toBeVisible({ timeout: 10000 });

    await page.goto("/default");
    await page.waitForLoadState("networkidle");

    const projectSwitcher = page.getByLabel("Select project");
    await expect(projectSwitcher).toHaveValue("default");
    await expect(page.getByRole("link", { name: "Default Project" })).toBeVisible();

    await projectSwitcher.selectOption("switcher-project");
    await page.waitForURL("**/switcher-project", { timeout: 15000 });
    await page.waitForLoadState("networkidle");

    await expect(projectSwitcher).toHaveValue("switcher-project");
    await expect(page.getByRole("heading", { level: 1, name: "Switcher Project" })).toBeVisible();
  });

  test("users tab shows user list", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Switch to users tab
    await page.getByRole("tab", { name: "users" }).click();
    await page.waitForTimeout(500);

    // Should see New User button and at least the admin user
    await expect(page.getByText("New User")).toBeVisible();
    await expect(page.getByText("admin@taskito.local")).toBeVisible();
  });

  test("can open create user dialog", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Switch to users tab
    await page.getByRole("tab", { name: "users" }).click();
    await page.waitForTimeout(500);

    await page.getByText("New User").click();

    // Dialog should appear
    await expect(page.getByText("Create User")).toBeVisible();
    await expect(page.locator('input[placeholder="John Doe"]')).toBeVisible();
    await expect(page.locator('input[placeholder="john@example.com"]')).toBeVisible();
  });

  test("settings link visible in navbar", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // The "Settings" link should be in the header
    const settingsLink = page.locator('header a[href="/settings"]');
    await expect(settingsLink).toBeVisible();
    await expect(settingsLink).toHaveText("Settings");
  });
});

test.describe("Search modal", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("search modal closes when clicking outside", async ({ page }) => {
    // Navigate to any page
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Open search via the button
    await page.locator("button", { hasText: "Search..." }).click();
    await page.waitForTimeout(300);

    // Search modal should be visible (look for the input)
    const searchInput = page.locator('input[placeholder="Search tasks or run a command..."]');
    await expect(searchInput).toBeVisible();

    // Click the backdrop (outside the modal) — use coordinates at bottom-right area
    await page.mouse.click(50, 600);
    await page.waitForTimeout(300);

    // Modal should be closed
    await expect(searchInput).not.toBeVisible();
  });

  test("search modal opens with Cmd+K", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Press Cmd+K
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);

    const searchInput = page.locator('input[placeholder="Search tasks or run a command..."]');
    await expect(searchInput).toBeVisible();

    // Press Escape to close
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await expect(searchInput).not.toBeVisible();
  });

  test("search modal toggles closed when Cmd+K is pressed twice", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const searchInput = page.locator('input[placeholder="Search tasks or run a command..."]');

    await page.keyboard.press("Meta+k");
    await expect(searchInput).toBeVisible();

    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);
    await expect(searchInput).not.toBeVisible();
  });
});
