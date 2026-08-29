import { test, expect } from "@playwright/test";

import {
  closeTaskDetail,
  waitForAppShell,
  createSprint,
  createTask,
  dragTaskDetailSection,
  goToDefaultProject,
  login,
  openBoardTaskDetail,
  switchToView,
  taskDetailPanel,
  todayPlus,
  uniqueName,
} from "./helpers";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function addComment(page: import("@playwright/test").Page, content: string) {
  const detail = taskDetailPanel(page);
  await detail.getByPlaceholder("Add a comment...").fill(content);
  await detail.getByRole("button", { name: "Send" }).click();
  await expect(detail.getByText(content)).toBeVisible({ timeout: 10_000 });
}

test.describe("Broader application coverage", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("task detail supports comments with attachments", async ({ page }) => {
    const title = uniqueName("Comment Attachment Task");
    const comment = uniqueName("Attached comment");

    await goToDefaultProject(page);
    await createTask(page, { title, dueDate: todayPlus(5), status: "To Do" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await openBoardTaskDetail(page, title);

    const detail = taskDetailPanel(page);
    const fileInput = detail.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: "note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Taskito attachment coverage"),
    });

    await detail.getByPlaceholder("Add a comment...").fill(comment);
    await detail.getByRole("button", { name: "Send" }).click();

    await expect(detail.getByText(comment)).toBeVisible({ timeout: 10_000 });
    await expect(detail.getByRole("link", { name: "note.txt" })).toBeVisible({ timeout: 10_000 });
    await expect(detail.getByPlaceholder("Add a comment...")).toHaveValue("");
  });

  test("task detail lets authors edit comments", async ({ page }) => {
    const title = uniqueName("Editable Comment Task");
    const originalComment = uniqueName("Original comment");
    const updatedComment = uniqueName("Updated comment");

    await goToDefaultProject(page);
    await createTask(page, { title, dueDate: todayPlus(5), status: "To Do" });
    await openBoardTaskDetail(page, title);

    const detail = taskDetailPanel(page);
    await addComment(page, originalComment);

    await detail.getByRole("button", { name: "Edit comment" }).click();
    await detail.locator("textarea").first().fill(updatedComment);
    await detail.getByRole("button", { name: "Save comment" }).click();

    await expect(detail.getByText(updatedComment)).toBeVisible({ timeout: 10_000 });
    await expect(detail.getByText(originalComment)).not.toBeVisible({ timeout: 10_000 });
  });

  test("new task dialog scales with the viewport without going full-screen", async ({ page }) => {
    await goToDefaultProject(page);
    await page.getByRole("button", { name: /New Task/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "New Task" })).toBeVisible();

    const dialogBox = await dialog.boundingBox();
    const viewport = page.viewportSize();

    expect(dialogBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(dialogBox!.width).toBeGreaterThanOrEqual(viewport!.width * 0.6);
    expect(dialogBox!.width).toBeLessThan(viewport!.width * 0.97);
  });

  test("task detail sections can be reordered from drag handles and persist after reopen", async ({ page }) => {
    test.slow();
    const title = uniqueName("Reorder Task Sections");

    await goToDefaultProject(page);
    await createTask(page, { title, description: "Task detail reorder coverage", dueDate: todayPlus(5), status: "To Do" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await openBoardTaskDetail(page, title);

    const detail = taskDetailPanel(page);
    await expect(detail.locator('[data-task-detail-section="timeTracking"]')).toBeVisible();
    await expect(detail.locator('[data-task-detail-section="overview"]')).toBeVisible();

    await dragTaskDetailSection(page, "overview", "timeTracking");

    const sectionIdsAfterReorder = await detail.locator("[data-task-detail-section]").evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-task-detail-section"))
    );
    expect(sectionIdsAfterReorder.indexOf("overview")).toBeLessThan(sectionIdsAfterReorder.indexOf("timeTracking"));

    await closeTaskDetail(page);
    await openBoardTaskDetail(page, title);

    const sectionIdsAfterReopen = await taskDetailPanel(page).locator("[data-task-detail-section]").evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-task-detail-section"))
    );
    expect(sectionIdsAfterReopen.indexOf("overview")).toBeLessThan(sectionIdsAfterReopen.indexOf("timeTracking"));
  });

  test("task links can be created and removed from task detail", async ({ page }) => {
    test.slow();
    const sourceTitle = uniqueName("Link Source");
    const targetTitle = uniqueName("Link Target");

    await goToDefaultProject(page);
    await createTask(page, { title: sourceTitle, dueDate: todayPlus(-30), status: "To Do" });
    await createTask(page, { title: targetTitle, dueDate: todayPlus(-29), status: "In Review" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await openBoardTaskDetail(page, sourceTitle);

    const detail = taskDetailPanel(page);
    await detail.getByRole("button", { name: "Add link" }).click();
    await detail.locator('select[name="linkType"]').selectOption("blocks");
    await detail.getByRole("button", { name: "Search for a task..." }).click();
    await detail.getByPlaceholder("Type to filter...").fill(targetTitle);
    const resultButton = detail.getByRole("button", { name: new RegExp(escapeRegex(targetTitle)) }).first();
    await expect(resultButton).toBeVisible({ timeout: 10_000 });
    await resultButton.click();
    await detail.getByRole("button", { name: "Create Link" }).click();
    await expect(detail.getByText(targetTitle)).toBeVisible({ timeout: 10_000 });

    await detail.getByLabel(/Remove link to/).click();
    await expect(detail.getByText(targetTitle)).not.toBeVisible({ timeout: 10_000 });
  });

  test("bulk actions can update status, assignee, and clear selection", async ({ page }) => {
    const batchPrefix = uniqueName("Bulk Batch");
    const firstTitle = `${batchPrefix} A`;
    const secondTitle = `${batchPrefix} B`;

    await goToDefaultProject(page);
    await createTask(page, { title: firstTitle, dueDate: todayPlus(-30), status: "Backlog" });
    await createTask(page, { title: secondTitle, dueDate: todayPlus(-29), status: "Backlog" });
    await switchToView(page, "board");

    await page.getByPlaceholder("Filter by title...").fill(batchPrefix);
    await page.getByLabel(`Select ${firstTitle}`).check();
    await page.getByLabel(`Select ${secondTitle}`).check();
    const selectedCount = page.locator("span.font-medium", { hasText: /^2 selected$/ });
    await expect(selectedCount).toBeVisible();

    await page.locator('select').filter({ has: page.locator('option:has-text("Move to status...")') }).first().selectOption({ label: "To Do" });
    await page.getByRole("button", { name: "Apply status" }).click();

    await page.reload({ waitUntil: "domcontentloaded" });
    await switchToView(page, "list");
    await page.getByPlaceholder("Filter by title...").fill(firstTitle);
    await expect(page.locator("tbody tr").filter({ hasText: firstTitle }).first().getByText("To Do", { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder("Filter by title...").fill(secondTitle);
    await expect(page.locator("tbody tr").filter({ hasText: secondTitle }).first().getByText("To Do", { exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByPlaceholder("Filter by title...").fill(batchPrefix);
    await page.getByLabel(`Select ${firstTitle}`).check();
    await page.getByLabel(`Select ${secondTitle}`).check();
    const assigneeSelect = page.locator('select').filter({ has: page.locator('option:has-text("Assign to...")') }).first();
    const assigneeText = await assigneeSelect.locator('option').allTextContents();
    const adminOption = assigneeText.find((label) => /admin@taskito\.local|Admin|Bence/i.test(label));
    expect(adminOption).toBeTruthy();
    await assigneeSelect.selectOption({ label: adminOption! });
    await page.getByRole("button", { name: "Apply assignee" }).click();

    await expect(page.getByText(adminOption!).first()).toBeVisible();

    await page.getByRole("button", { name: "Clear selection" }).click();
    await expect(selectedCount).not.toBeVisible();
  });

  test("sprint member assignment is managed from a dialog and persists", async ({ page }) => {
    const sprintName = uniqueName("Managed Sprint");

    await goToDefaultProject(page);
    const sprintPicker = await createSprint(page, sprintName, "Dialog member management", 0);
    await sprintPicker.selectOption({ label: `${sprintName} (planning)` });

    await page.getByRole("button", { name: "Assign sprint members" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Assign sprint members" })).toBeVisible();
    const memberCheckboxes = dialog.locator('input[name="assignedMemberIds"]');
    const count = await memberCheckboxes.count();
    if (count > 0) {
      await memberCheckboxes.first().check();
    }
    await dialog.getByRole("button", { name: "Save sprint members" }).click();

    if (count > 0) {
      await expect(page.locator("section").getByText("Sprint team", { exact: true })).toBeVisible();
      await expect(page.locator("section").getByText(/admin@taskito\.local|Admin|Bence/i).first()).toBeVisible({ timeout: 10_000 });
    }
  });

  test("theme toggle persists across reloads", async ({ page }) => {
    await goToDefaultProject(page);
    const themeToggle = page.getByLabel(/Theme:/);
    const before = await themeToggle.getAttribute("aria-label");

    // The toggle persists the new scheme via user.updateAppearance; wait for
    // that mutation before reloading or the change would be lost.
    const persistResponse = page.waitForResponse((response) =>
      response.url().includes("user.updateAppearance") && response.request().method() === "POST"
    );
    await themeToggle.click();
    await expect(themeToggle).not.toHaveAttribute("aria-label", before ?? "", { timeout: 5_000 });
    const after = await themeToggle.getAttribute("aria-label");

    expect(after).not.toBe(before);
    const expectedTheme = after?.replace("Theme: ", "") ?? "";
    await persistResponse;
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel(`Theme: ${expectedTheme}`)).toBeVisible();
  });

  test("invalid project slug recovers to an available project", async ({ page }) => {
    await page.goto("/totally-missing-project-slug");
    await page.waitForLoadState("networkidle");
    await page.waitForURL((url) => url.pathname !== "/totally-missing-project-slug", { timeout: 15_000 });
    await waitForAppShell(page);
    await expect(page).toHaveURL(/\/(default|test|switcher-project)/);
  });

  test("notification center can mark all read and clear all", async ({ page }) => {
    const title = uniqueName("Notification Task");
    await goToDefaultProject(page);
    await createTask(page, { title, dueDate: todayPlus(4), status: "To Do" });
    await openBoardTaskDetail(page, title);
    const detail = taskDetailPanel(page);
    await detail.getByRole("button", { name: "Watch" }).click();
    await addComment(page, uniqueName("Notification comment"));
    await closeTaskDetail(page);

    await page.getByLabel("Open notifications").click();
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
    await page.getByRole("button", { name: "Mark all read" }).click();
    await page.getByRole("button", { name: "Clear all", exact: true }).click();
    await expect(page.getByText("No notifications yet")).toBeVisible({ timeout: 10_000 });
  });
});
