import { test, expect, type Page } from "@playwright/test";

import { createSprint, createTask, expectTaskDetailOpen, goToDefaultProject, login, openBoardTaskDetail, switchToView, taskDetailPanel, todayPlus, uniqueName } from "./helpers";

async function dragSprintTaskBetweenColumns(page: Page, fromStatus: string, toStatus: string) {
  const fromColumn = page.locator(`[data-sprint-status-id]`, { has: page.getByRole("heading", { name: fromStatus }) }).first();
  const toColumn = page.locator(`[data-sprint-status-id]`, { has: page.getByRole("heading", { name: toStatus }) }).first();
  const taskCard = fromColumn.locator("[data-sprint-task-id]").first();
  await taskCard.scrollIntoViewIfNeeded();
  await toColumn.scrollIntoViewIfNeeded();
  const sourceBox = await taskCard.boundingBox();
  const targetBox = await toColumn.boundingBox();

  if (!sourceBox || !targetBox) {
    throw new Error("Unable to determine sprint drag coordinates");
  }

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + Math.min(24, sourceBox.height / 2));
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + Math.min(40, targetBox.height / 2), { steps: 12 });
  await page.mouse.up();
}

test.describe("Expanded Playwright coverage", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("workflow settings can add and remove a temporary status", async ({ page }) => {
    const statusName = uniqueName("Playwright Status");

    await page.goto("/default/settings/workflow");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Workflow Settings" })).toBeVisible();
    await page.getByPlaceholder("New status name").fill(statusName);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const statusLabel = page.locator("span.flex-1.font-medium", { hasText: statusName }).first();
    await expect(statusLabel).toBeVisible({ timeout: 10_000 });

    page.once("dialog", (dialog) => void dialog.accept());
    const row = statusLabel.locator('xpath=ancestor::div[contains(@class,"rounded-2xl")]').first();
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(statusLabel).not.toBeVisible({ timeout: 10_000 });
  });

  test("tag settings can create, rename, and delete a tag", async ({ page }) => {
    const originalName = uniqueName("Playwright Tag");
    const renamedName = `${originalName} Renamed`;

    await page.goto("/default/settings/tags");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Tag Management" })).toBeVisible();
    await page.getByPlaceholder("New tag name").fill(originalName);
    await page.getByRole("button", { name: "Create Tag" }).click();
    const tagLabel = page.locator("span.flex-1.font-medium", { hasText: originalName }).first();
    await expect(tagLabel).toBeVisible({ timeout: 10_000 });

    const row = tagLabel.locator('xpath=ancestor::div[contains(@class,"rounded-2xl")]').first();
    await row.getByRole("button", { name: "Rename" }).click();
    await page.locator(`input[value="${originalName}"]`).first().fill(renamedName);
    await page.getByRole("button", { name: "Save" }).click();
    const renamedLabel = page.locator("span.flex-1.font-medium", { hasText: renamedName }).first();
    await expect(renamedLabel).toBeVisible({ timeout: 10_000 });

    page.once("dialog", (dialog) => void dialog.accept());
    const renamedRow = renamedLabel.locator('xpath=ancestor::div[contains(@class,"rounded-2xl")]').first();
    await renamedRow.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(renamedName, { exact: true })).not.toBeVisible({ timeout: 10_000 });
  });

  test("project AI settings policy changes persist after save", async ({ page }) => {
    await page.goto("/default/settings/ai");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /AI Settings For/i })).toBeVisible();

    const allowYolo = page.getByLabel("Allow Yolo mode");
    const initial = await allowYolo.isChecked();
    await allowYolo.setChecked(!initial);
    await page.getByRole("button", { name: "Save Policy" }).click();
    await expect(page.getByRole("button", { name: "Save Policy" })).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel("Allow Yolo mode")).toBeChecked({ checked: !initial });

    await page.getByLabel("Allow Yolo mode").setChecked(initial);
    await page.getByRole("button", { name: "Save Policy" }).click();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel("Allow Yolo mode")).toBeChecked({ checked: initial });
  });

  test("search modal supports keyboard selection and command navigation", async ({ page }) => {
    await goToDefaultProject(page);

    await page.keyboard.press("Meta+k");
    const searchInput = page.getByPlaceholder("Search tasks or run a command...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("drag-and-drop");
    await expect(page.locator('#search-modal-results [role="option"]').first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expectTaskDetailOpen(page);

    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+k");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("automation");
    await page.getByRole("button", { name: "Automation settings" }).click();
    await expect(page.getByRole("heading", { name: "Workflow automation" })).toBeVisible({ timeout: 10_000 });
  });

  test("task can be archived and restored from archive view", async ({ page }) => {
    const title = uniqueName("Archive Task");

    await goToDefaultProject(page);
    await createTask(page, { title, dueDate: todayPlus(5), status: "Done" });
    await openBoardTaskDetail(page, title);
    await page.getByRole("button", { name: "Archive now" }).click();
    // Archiving is confirm-gated (in-app ConfirmDialog, no native confirm())
    await page.getByRole("dialog").getByRole("button", { name: "Archive", exact: true }).click();

    await switchToView(page, "archive");
    const archivedTitle = page.locator("h3", { hasText: title }).first();
    await expect(archivedTitle).toBeVisible({ timeout: 10_000 });
    const archivedRow = archivedTitle.locator('xpath=ancestor::div[contains(@class,"flex") and contains(@class,"items-center")]').first();
    await archivedRow.getByRole("button", { name: "Restore" }).click();
    await expect(archivedRow).not.toBeVisible({ timeout: 10_000 });
  });

  test("selected tasks can be assigned to a sprint from board and remain visible in board and list", async ({ page }) => {
    const sprintName = uniqueName("Selection Sprint");
    const taskTitle = uniqueName("Sprint Selection Task");

    await goToDefaultProject(page);
    await createSprint(page, sprintName, "Selection workflow");
    await switchToView(page, "board");
    await createTask(page, { title: taskTitle, dueDate: todayPlus(4), status: "To Do" });

    await page.getByPlaceholder("Filter by title...").fill(taskTitle);
    await page.getByLabel(`Select ${taskTitle}`).check();
    await page.getByLabel("Select sprint for selected tasks").selectOption({ label: `${sprintName} (planning)` });
    await page.getByRole("button", { name: "Apply sprint" }).click();

    await expect(page.getByText(`Sprint: ${sprintName}`)).toBeVisible({ timeout: 10_000 });

    await switchToView(page, "list");
    await page.getByPlaceholder("Filter by title...").fill(taskTitle);
    await expect(page.getByText(`Sprint: ${sprintName}`)).toBeVisible({ timeout: 10_000 });
  });

  test("new sprint creation shows inline acknowledgement and members can be assigned", async ({ page }) => {
    const sprintName = uniqueName("Team Sprint");

    await goToDefaultProject(page);
    await switchToView(page, "sprint");
    await expect(page.getByLabel("Select Sprint")).toBeVisible();
    await page.getByRole("button", { name: "Create Sprint" }).click();
    const createDialog = page.getByRole("dialog");
    await createDialog.locator('input[name="name"]').fill(sprintName);
    await createDialog.locator('input[name="goal"]').fill("Team assignment workflow");
    const memberCheckboxes = createDialog.locator('input[name="memberIds"]');
    const memberCount = await memberCheckboxes.count();
    if (memberCount > 0) {
      await memberCheckboxes.first().check();
    }
    await createDialog.getByRole("button", { name: "Create Sprint", exact: true }).click();

    await expect(page.getByText(`Sprint “${sprintName}” created.`)).toBeVisible({ timeout: 10_000 });
    if (memberCount > 0) {
      await page.getByRole("button", { name: "Assign sprint members" }).click();
      const memberDialog = page.getByRole("dialog");
      await expect(memberDialog.getByRole("heading", { name: "Assign sprint members" })).toBeVisible();
      await expect(memberDialog.locator('input[name="assignedMemberIds"]').first()).toBeChecked();
      await memberDialog.getByRole("button", { name: "Save sprint members" }).click();
    }
    await page.getByLabel("Dismiss sprint created acknowledgement").click();
    await expect(page.getByText(`Sprint “${sprintName}” created.`)).not.toBeVisible({ timeout: 10_000 });
  });

  test("sprint view supports drag and drop between status lanes", async ({ page }) => {
    const sprintName = uniqueName("Drag Sprint");
    const taskTitle = uniqueName("Sprint Drag Task");

    await goToDefaultProject(page);
    await createSprint(page, sprintName, "Drag workflow");
    await switchToView(page, "board");
    await createTask(page, { title: taskTitle, dueDate: todayPlus(3), status: "Backlog" });
    await page.getByPlaceholder("Filter by title...").fill(taskTitle);
    await page.getByLabel(`Select ${taskTitle}`).check();
    await page.getByLabel("Select sprint for selected tasks").selectOption({ label: `${sprintName} (planning)` });
    await page.getByRole("button", { name: "Apply sprint" }).click();

    await switchToView(page, "sprint");
    const sprintPicker = page.getByLabel("Select Sprint");
    await sprintPicker.selectOption({ label: `${sprintName} (planning)` });
    await expect(page.locator('[data-sprint-status-id] [data-sprint-task-id]').first()).toBeVisible({ timeout: 10_000 });

    await dragSprintTaskBetweenColumns(page, "Backlog", "To Do");
    await expect(
      page.locator(`[data-sprint-status-id]`, { has: page.getByRole("heading", { name: "To Do" }) }).getByText(taskTitle)
    ).toBeVisible({ timeout: 10_000 });
  });

  test("completed sprint is minimized by default and can expand/minimize again", async ({ page }) => {
    const sprintName = uniqueName("Completed Sprint");

    await goToDefaultProject(page);
    const sprintPicker = await createSprint(page, sprintName, "Collapse workflow");
    await sprintPicker.selectOption({ label: `${sprintName} (planning)` });
    await page.getByRole("button", { name: "Complete" }).click();
    // Completing goes through the carry-over dialog now; keep the default
    // target and confirm.
    const completeDialog = page.getByRole("dialog", { name: "Complete sprint" });
    await completeDialog.getByRole("button", { name: "Complete sprint" }).click();
    await expect(completeDialog).not.toBeVisible({ timeout: 10_000 });

    await expect(page.getByText(`${sprintName} is completed`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Expand sprint" })).toBeVisible();

    await page.getByRole("button", { name: "Expand sprint" }).click();
    await expect(page.getByRole("button", { name: "Minimize sprint" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-sprint-status-id]").first()).toBeVisible();

    await page.getByRole("button", { name: "Minimize sprint" }).click();
    await expect(page.getByRole("button", { name: "Expand sprint" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(`${sprintName} is completed`)).toBeVisible();
  });

  test("project view preference persists across revisits", async ({ page }) => {
    await goToDefaultProject(page);
    await switchToView(page, "gantt");
    await expect(page.getByText("Gantt timeline")).toBeVisible();

    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.goto("/default");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Gantt timeline")).toBeVisible({ timeout: 10_000 });
  });

  test("task can be deleted from detail edit mode", async ({ page }) => {
    // Prefix avoids UI words like "Delete" that could collide with button
    // accessible names via substring matching.
    const title = uniqueName("Disposable Task");

    await goToDefaultProject(page);
    await createTask(page, { title, dueDate: todayPlus(6), status: "To Do", description: "Delete me" });
    await openBoardTaskDetail(page, title);
    await taskDetailPanel(page).getByRole("button", { name: "Edit", exact: true }).click();
    // The edit-mode Delete button lives inside the task detail panel; scope to
    // it so board cards whose titles contain "Delete" cannot match too.
    await taskDetailPanel(page).getByRole("button", { name: "Delete", exact: true }).first().click();
    // Deletion is confirm-gated by the in-app ConfirmDialog (no native confirm()).
    await page.getByRole("dialog", { name: "Delete this task?" }).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(taskDetailPanel(page)).not.toBeVisible({ timeout: 10_000 });

    await switchToView(page, "board");
    await page.getByPlaceholder("Filter by title...").fill(title);
    await expect(page.getByText(title, { exact: true })).not.toBeVisible();
  });

  test("notification center opens with controls and preferences", async ({ page }) => {
    await goToDefaultProject(page);
    await page.getByLabel("Open notifications").click();

    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark all read" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear all" })).toBeVisible();
    await expect(page.getByText("Preferences")).toBeVisible();
    // One checkbox per channel and type: "<Label> in-app" and "<Label> email".
    for (const label of ["Assignments", "Comments", "Status changes", "Mentions"]) {
      await expect(page.getByLabel(`${label} in-app`, { exact: true })).toBeVisible();
      await expect(page.getByLabel(`${label} email`, { exact: true })).toBeVisible();
    }
    await expect(page.getByLabel("Daily due-soon digest email", { exact: true })).toBeVisible();

    // Toggle an EMAIL channel checkbox and verify the choice persists after
    // closing and reopening the center.
    const statusEmailToggle = page.getByLabel("Status changes email", { exact: true });
    const initiallyChecked = await statusEmailToggle.isChecked();
    await statusEmailToggle.click();
    await expect(statusEmailToggle).toBeChecked({ checked: !initiallyChecked });

    await page.getByLabel("Open notifications").click();
    await expect(statusEmailToggle).not.toBeVisible();
    await page.getByLabel("Open notifications").click();
    await expect(statusEmailToggle).toBeChecked({ checked: !initiallyChecked });

    // Restore the original preference so reruns start from the same state.
    await statusEmailToggle.click();
    await expect(statusEmailToggle).toBeChecked({ checked: initiallyChecked });
  });
});
