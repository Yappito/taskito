import { test, expect, type Page } from "@playwright/test";

import {
  closeTaskDetail,
  createTask,
  escapeRegex,
  expectTaskDetailOpen,
  goToDefaultProject,
  login,
  openBoardTaskDetail,
  switchToView,
  taskDetailPanel,
  todayPlus,
  uniqueName,
  waitForAppShell,
} from "./helpers";

async function logout(page: Page) {
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL("**/login", { timeout: 15_000 });
}

async function openNewTaskDialog(page: Page) {
  await page.getByRole("button", { name: /New Task/ }).click();
  await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
}

async function filterBoardByTitle(page: Page, title: string) {
  await switchToView(page, "board");
  const filterInput = page.getByPlaceholder("Filter by title...");
  await filterInput.fill(title);
  // No fixed sleep: callers assert the filtered task right away and visibility
  // waits cover the search debounce (250ms) plus the refetch.
}

async function openTaskLinkForm(page: Page) {
  const detailPanel = page.locator(".fixed.inset-y-0.right-0");
  await detailPanel.getByRole("button", { name: "Add link" }).click();
  await expect(detailPanel.getByRole("button", { name: "Create Link" })).toBeVisible();
}

async function addTaskLink(page: Page, sourceTitle: string, linkType: "parent" | "child" | "blocks", targetTitle: string) {
  await openBoardTaskDetail(page, sourceTitle);
  const detailPanel = page.locator(".fixed.inset-y-0.right-0");
  await openTaskLinkForm(page);
  await detailPanel.locator('select[name="linkType"]').selectOption(linkType);
  await detailPanel.getByRole("button", { name: "Search for a task..." }).click();
  await detailPanel.getByPlaceholder("Type to filter...").fill(targetTitle);
  const resultButton = detailPanel.getByRole("button", {
    name: new RegExp(escapeRegex(targetTitle)),
  }).first();
  await expect(resultButton).toBeVisible({ timeout: 10_000 });
  await resultButton.click();
  await detailPanel.getByRole("button", { name: "Create Link" }).click();
  await expect(detailPanel.getByText(targetTitle)).toBeVisible({ timeout: 10_000 });
  await closeTaskDetail(page);
}

async function updateTaskStatusToDoneExpectingError(page: Page, title: string, expectedMessage: RegExp) {
  await openBoardTaskDetail(page, title);
  const detailPanel = page.locator(".fixed.inset-y-0.right-0");
  await detailPanel.getByRole("button", { name: "Edit", exact: true }).click();
  await detailPanel.locator('select[name="statusId"]').selectOption({ label: "Done" });
  await detailPanel.getByRole("button", { name: "Save" }).click();
  await expect(detailPanel.getByText(expectedMessage)).toBeVisible({ timeout: 10_000 });
  await expect(detailPanel.getByRole("button", { name: "Save" })).toBeVisible();
  await detailPanel.getByRole("button", { name: "Cancel" }).click();
}

async function createMemberUser(page: Page, options: { name: string; email: string; password: string }) {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "users" }).click();
  await page.getByText("New User").click();
  await page.getByPlaceholder("John Doe").fill(options.name);
  await page.getByPlaceholder("john@example.com").fill(options.email);
  await page.getByPlaceholder("Min 12 characters").fill(options.password);
  await page.locator("label", { hasText: "Default Project" }).locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(options.email)).toBeVisible({ timeout: 10_000 });
}

async function deleteUserByEmail(page: Page, email: string) {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "users" }).click();

  const userRow = page.locator("div.rounded-lg", { hasText: email }).first();
  if (!(await userRow.isVisible().catch(() => false))) {
    return;
  }

  await userRow.getByRole("button", { name: "Delete" }).click();
  // Deletion is guarded by the in-app confirm dialog (no native confirm())
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(email)).not.toBeVisible({ timeout: 10_000 });
}

test.describe("Backlog regression coverage", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("templates can be saved and reused from quick add", async ({ page }) => {
    const title = uniqueName("Template Task");
    const templateName = uniqueName("Template Preset");
    const description = uniqueName("Template body");

    await goToDefaultProject(page);
    await createTask(page, {
      title,
      description,
      dueDate: todayPlus(10),
      status: "In Review",
      priority: "high",
      tagNames: ["frontend"],
      saveAsTemplate: templateName,
    });

    await page.reload();
    await waitForAppShell(page);

    await filterBoardByTitle(page, title);
    await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });

    await openNewTaskDialog(page);
    const templateSelect = page.locator('select').filter({ has: page.locator('option:has-text("No template")') }).first();
    await templateSelect.selectOption({ label: templateName });
    await expect(page.getByPlaceholder("Task title...")).toHaveValue(title);
    await expect(page.getByPlaceholder("Add task details...")).toHaveValue(description);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  });

  test("task detail duplicate creates a copied task", async ({ page }) => {
    const title = uniqueName("Duplicate Source");

    await goToDefaultProject(page);
    await createTask(page, {
      title,
      description: "Original body",
      dueDate: todayPlus(8),
      status: "In Review",
    });

    await openBoardTaskDetail(page, title);
    const detailPanel = page.locator(".fixed.inset-y-0.right-0");
    await detailPanel.getByRole("button", { name: "Duplicate" }).click();
    await closeTaskDetail(page);

    await page.getByPlaceholder("Filter by title...").fill(`Copy of ${title}`);
    // Duplication invalidated the task list; the visibility wait below covers
    // the board refetch (no fixed sleep needed).
    await expect(page.getByText(`Copy of ${title}`)).toBeVisible({ timeout: 10_000 });
  });

  test("task updates are recorded in the activity log", async ({ page }) => {
    const title = uniqueName("Activity Task");
    const updatedTitle = `${title} Updated`;

    await goToDefaultProject(page);
    await createTask(page, {
      title,
      description: "Activity start",
      dueDate: todayPlus(7),
      status: "To Do",
    });

    await openBoardTaskDetail(page, title);
    const detailPanel = page.locator(".fixed.inset-y-0.right-0");
    await detailPanel.getByRole("button", { name: "Edit", exact: true }).click();
    await detailPanel.locator('input[name="title"]').fill(updatedTitle);
    await detailPanel.locator('textarea[name="body"]').fill("Activity changed body");
    await detailPanel.getByRole("button", { name: "Save" }).click();

    await expect(detailPanel.getByText("Activity")).toBeVisible();
    await expect(detailPanel.getByText("Updated:")).toBeVisible({ timeout: 10_000 });
  });

  test("custom fields can be configured and used on tasks", async ({ page }) => {
    const fieldName = uniqueName("Customer");
    const taskTitle = uniqueName("Custom Field Task");
    const fieldValue = uniqueName("Acme Corp");

    await page.goto("/default/settings/custom-fields");
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Customer, Estimate, Release date...").fill(fieldName);
    await page.getByRole("button", { name: "Add field" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText(fieldName)).toBeVisible({ timeout: 10_000 });

    await goToDefaultProject(page);
    await createTask(page, {
      title: taskTitle,
      dueDate: todayPlus(9),
      status: "To Do",
      customFieldValues: {
        [fieldName]: fieldValue,
      },
    });

    await openBoardTaskDetail(page, taskTitle);
    const detailPanel = taskDetailPanel(page);
    // The rewritten task detail panel shows custom field values in view mode
    // inside the "Details" section: a muted "Custom Fields" group label plus
    // one card per field (field name, then its value). The NAME and VALUE the
    // test set are the meaningful assertions.
    const detailsSection = detailPanel.locator('[data-task-detail-section="details"]');
    await expect(detailsSection).toBeVisible();
    await expect(detailsSection.getByText(fieldName)).toBeVisible();
    await expect(detailsSection.getByText(fieldValue)).toBeVisible();
  });

  test("saved filter presets can be stored and reapplied", async ({ page }) => {
    const presetName = uniqueName("Preset");

    await goToDefaultProject(page);
    await switchToView(page, "list");
    await page.getByRole("button", { name: /Show filters/ }).click();
    await page.getByPlaceholder("Filter by title...").fill("drag-and-drop");
    await page.getByPlaceholder("Preset name").fill(presetName);
    await page.getByRole("button", { name: "Save preset" }).click();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await switchToView(page, "list");
    await page.getByRole("button", { name: /Show filters|Hide filters/ }).click();
    await expect(page.getByRole("button", { name: presetName, exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Clear all filters" }).click();
    await expect(page.getByPlaceholder("Filter by title...")).toHaveValue("");

    await page.getByRole("button", { name: presetName, exact: true }).click();
    await expect(page.getByPlaceholder("Filter by title...")).toHaveValue("drag-and-drop");
    await expect(page.getByText("Add drag-and-drop to board")).toBeVisible();
  });

  test("watch controls and notification preferences are available", async ({ page }) => {
    const title = uniqueName("Watched Task");

    await goToDefaultProject(page);
    await createTask(page, {
      title,
      dueDate: todayPlus(7),
      status: "To Do",
    });

    await openBoardTaskDetail(page, title);
    const detailPanel = page.locator(".fixed.inset-y-0.right-0");
    await expect(detailPanel.getByRole("button", { name: "Unwatch" })).toBeVisible();
    await detailPanel.getByRole("button", { name: "Unwatch" }).click();
    await expect(detailPanel.getByRole("button", { name: "Watch" })).toBeVisible({ timeout: 10_000 });
    await detailPanel.getByRole("button", { name: "Watch" }).click();
    await expect(detailPanel.getByRole("button", { name: "Unwatch" })).toBeVisible({ timeout: 10_000 });

    await closeTaskDetail(page);
    await page.getByLabel("Open notifications").click({ force: true });
    await expect(page.getByText("Preferences")).toBeVisible();
    // Preferences rows now carry one checkbox per channel (aria-labels "<Label> in-app" / "<Label> email").
    const assignmentsToggle = page.getByLabel("Assignments in-app", { exact: true });
    await assignmentsToggle.click();
    await expect(assignmentsToggle).not.toBeChecked();
    await assignmentsToggle.click();
    await expect(assignmentsToggle).toBeChecked();

    // Toggle an EMAIL channel checkbox too and verify it persists after the
    // notification center is closed and reopened.
    const commentsEmailToggle = page.getByLabel("Comments email", { exact: true });
    const emailInitiallyChecked = await commentsEmailToggle.isChecked();
    await commentsEmailToggle.click();
    await expect(commentsEmailToggle).toBeChecked({ checked: !emailInitiallyChecked });

    await page.getByLabel("Open notifications").click({ force: true });
    await expect(commentsEmailToggle).not.toBeVisible();
    await page.getByLabel("Open notifications").click({ force: true });
    await expect(page.getByText("Preferences")).toBeVisible();
    await expect(commentsEmailToggle).toBeChecked({ checked: !emailInitiallyChecked });

    // Restore the original preference so reruns start from the same state.
    await commentsEmailToggle.click();
    await expect(commentsEmailToggle).toBeChecked({ checked: emailInitiallyChecked });
  });

  test("assignment notifications reach another project member", async ({ page }) => {
    const name = uniqueName("Notify User");
    const email = `${Date.now()}-notify@taskito.local`;
    const password = "member-user-2026";

    try {
      await createMemberUser(page, { name, email, password });

      await goToDefaultProject(page);
      await openBoardTaskDetail(page, "Add drag-and-drop to board");
      const detailPanel = page.locator(".fixed.inset-y-0.right-0");
      await detailPanel.getByRole("button", { name: "Edit", exact: true }).click();
      await detailPanel.locator('select[name="assigneeId"]').selectOption({ label: name });
      await detailPanel.getByRole("button", { name: "Save" }).click();
      // The member name appears in the assignee card; scope there so the
      // participants row (which also lists the assignee) cannot double-match.
      const assigneeCard = detailPanel.locator("div.rounded-2xl").filter({ hasText: "Assignee" }).first();
      await expect(assigneeCard.getByText(name)).toBeVisible({ timeout: 10_000 });

      await closeTaskDetail(page);
      await logout(page);
      await login(page, email, password);
      await goToDefaultProject(page);
      await page.getByLabel("Open notifications").click();
      await expect(page.getByText(/assigned you to DEF-/i)).toBeVisible({ timeout: 10_000 });
    } finally {
      await logout(page).catch(() => undefined);
      await login(page).catch(() => undefined);
      await deleteUserByEmail(page, email).catch(() => undefined);
    }
  });

  test("blocks links prevent terminal transitions", async ({ page }) => {
    test.slow();
    const blockerTitle = uniqueName("Blocking Task");
    const blockedTitle = uniqueName("Blocked Task");

    await goToDefaultProject(page);
    await createTask(page, {
      title: blockerTitle,
      dueDate: todayPlus(-30),
      status: "To Do",
    });
    await createTask(page, {
      title: blockedTitle,
      dueDate: todayPlus(-29),
      status: "In Review",
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppShell(page);

    await addTaskLink(page, blockerTitle, "blocks", blockedTitle);
    await updateTaskStatusToDoneExpectingError(page, blockedTitle, /blocking tasks are still open/i);
  });

  test("parent links prevent completing a parent with open children", async ({ page }) => {
    test.slow();
    const parentTitle = uniqueName("Parent Task");
    const childTitle = uniqueName("Child Task");

    await goToDefaultProject(page);
    await createTask(page, {
      title: parentTitle,
      dueDate: todayPlus(-365),
      status: "In Review",
    });
    await createTask(page, {
      title: childTitle,
      dueDate: todayPlus(-365),
      status: "To Do",
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppShell(page);

    await addTaskLink(page, parentTitle, "parent", childTitle);
    await updateTaskStatusToDoneExpectingError(page, parentTitle, /child tasks are still open/i);
  });

  test("child links also prevent completing the linked parent task", async ({ page }) => {
    test.slow();
    const parentTitle = uniqueName("Hierarchy Parent");
    const childTitle = uniqueName("Child Task");

    await goToDefaultProject(page);
    await createTask(page, {
      title: parentTitle,
      dueDate: todayPlus(-365),
      status: "In Review",
    });
    await createTask(page, {
      title: childTitle,
      dueDate: todayPlus(-365),
      status: "To Do",
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppShell(page);

    await addTaskLink(page, childTitle, "child", parentTitle);
    await updateTaskStatusToDoneExpectingError(page, parentTitle, /child tasks are still open/i);
  });
});
