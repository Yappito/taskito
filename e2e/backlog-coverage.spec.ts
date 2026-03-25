import { test, expect, type Page } from "@playwright/test";

function uniqueName(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

function todayPlus(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().split("T")[0];
}

async function login(page: Page, email = "admin@taskito.local", password = "taskito-demo-2026") {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    try {
      await page.waitForURL((url) => !url.pathname.includes("/login"), {
        timeout: 15_000,
      });
      return;
    } catch (error) {
      const hasInvalidCredentials = await page.getByText("Invalid email or password").isVisible().catch(() => false);
      if (!hasInvalidCredentials || attempt === 1) {
        throw error;
      }
    }
  }
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL("**/login", { timeout: 15_000 });
}

async function goToDefaultProject(page: Page) {
  await page.goto("/default");
  await page.waitForLoadState("networkidle");
}

async function switchToView(page: Page, view: "list" | "board" | "graph" | "archive") {
  await page.getByRole("button", { name: view }).click();
  await page.waitForTimeout(400);
}

async function openNewTaskDialog(page: Page) {
  await page.getByRole("button", { name: /New Task/ }).click();
  await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
}

async function createTask(page: Page, options: {
  title: string;
  description?: string;
  dueDate?: string;
  status?: string;
  priority?: "none" | "low" | "medium" | "high" | "urgent";
  assignee?: string;
  tagNames?: string[];
  saveAsTemplate?: string;
  templateToUse?: string;
  customFieldValues?: Record<string, string>;
}) {
  await openNewTaskDialog(page);

  if (options.templateToUse) {
    await page.locator('select').first().selectOption({ label: options.templateToUse });
    await page.waitForTimeout(200);
  }

  await page.getByPlaceholder("Task title...").fill(options.title);

  if (options.description !== undefined) {
    await page.getByPlaceholder("Add task details...").fill(options.description);
  }

  if (options.dueDate) {
    await page.locator('input[name="dueDate"]').fill(options.dueDate);
  }

  if (options.priority) {
    await page.locator('select[name="priority"]').selectOption(options.priority);
  }

  if (options.status) {
    await page.locator('select[name="statusId"]').selectOption({ label: options.status });
  }

  if (options.assignee) {
    await page.locator('select[name="assigneeId"]').selectOption({ label: options.assignee });
  }

  for (const tagName of options.tagNames ?? []) {
    await page.locator("label", { hasText: tagName }).locator('input[type="checkbox"]').check();
  }

  for (const [fieldName, value] of Object.entries(options.customFieldValues ?? {})) {
    const fieldGroup = page.locator("div").filter({ has: page.locator("label", { hasText: fieldName }) }).first();
    const input = fieldGroup.locator("input, select").first();
    await input.fill(value);
  }

  if (options.saveAsTemplate) {
    await page.locator("label", { hasText: "Save this draft as a reusable template" }).locator('input[type="checkbox"]').check();
    await page.getByPlaceholder("Template name").fill(options.saveAsTemplate);
  }

  await page.getByRole("button", { name: "Create Task" }).click();
  await page.waitForTimeout(1000);

  const dialogHeading = page.getByRole("heading", { name: "New Task" });
  if (await dialogHeading.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Cancel" }).click();
  }

  await expect(dialogHeading).not.toBeVisible({ timeout: 10_000 });
}

async function filterBoardByTitle(page: Page, title: string) {
  await switchToView(page, "board");
  const filterInput = page.getByPlaceholder("Filter by title...");
  await filterInput.fill(title);
  await page.waitForTimeout(400);
}

async function openBoardTaskDetail(page: Page, title: string) {
  await filterBoardByTitle(page, title);
  await page.getByRole("heading", { name: title }).first().click();
  await expect(page.getByText("Task Detail")).toBeVisible({ timeout: 10_000 });
}

async function openTaskLinkForm(page: Page) {
  const detailPanel = page.locator(".fixed.inset-y-0.right-0");
  await detailPanel.getByRole("button", { name: "+ Add" }).click();
  await expect(detailPanel.getByRole("button", { name: "Create Link" })).toBeVisible();
}

async function closeTaskDetail(page: Page) {
  const detailPanel = page.locator(".fixed.inset-y-0.right-0");
  await detailPanel.getByRole("button", { name: "✕" }).first().click();
  await expect(page.getByText("Task Detail")).not.toBeVisible({ timeout: 10_000 });
}

async function addTaskLink(page: Page, sourceTitle: string, linkType: "parent" | "child" | "blocks", targetTitle: string) {
  await openBoardTaskDetail(page, sourceTitle);
  const detailPanel = page.locator(".fixed.inset-y-0.right-0");
  await openTaskLinkForm(page);
  await detailPanel.locator('select[name="linkType"]').selectOption(linkType);
  await detailPanel.getByRole("button", { name: "Search for a task..." }).click();
  await detailPanel.getByPlaceholder("Type to filter...").fill(targetTitle);
  await detailPanel.getByRole("button", { name: new RegExp(targetTitle) }).click();
  await detailPanel.getByRole("button", { name: "Create Link" }).click();
  await expect(detailPanel.getByText(targetTitle)).toBeVisible({ timeout: 10_000 });
  await closeTaskDetail(page);
}

async function updateTaskStatusToDoneExpectingError(page: Page, title: string, expectedMessage: RegExp) {
  await openBoardTaskDetail(page, title);
  const detailPanel = page.locator(".fixed.inset-y-0.right-0");
  await detailPanel.getByRole("button", { name: "Edit" }).click();
  await detailPanel.locator('select[name="statusId"]').selectOption({ label: "Done" });
  await detailPanel.getByRole("button", { name: "Save" }).click();
  await expect(detailPanel.getByText(expectedMessage)).toBeVisible({ timeout: 10_000 });
  await expect(detailPanel.getByRole("button", { name: "Save" })).toBeVisible();
  await detailPanel.getByRole("button", { name: "Cancel" }).click();
}

async function createMemberUser(page: Page, options: { name: string; email: string; password: string }) {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "users" }).click();
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
  await page.getByRole("button", { name: "users" }).click();

  const userRow = page.locator("div.rounded-lg", { hasText: email }).first();
  if (!(await userRow.isVisible().catch(() => false))) {
    return;
  }

  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await userRow.getByRole("button", { name: "Delete" }).click();
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
    await page.waitForLoadState("networkidle");

    await filterBoardByTitle(page, title);
    await expect(page.getByText(title)).toBeVisible();

    await openNewTaskDialog(page);
    await page.locator('select').first().selectOption({ label: templateName });
    await expect(page.getByPlaceholder("Task title...")).toHaveValue(title);
    await expect(page.getByPlaceholder("Add task details...")).toHaveValue(description);
    await page.getByRole("button", { name: "Cancel" }).click();
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
    await page.waitForTimeout(1000);
    await closeTaskDetail(page);

    await page.getByPlaceholder("Filter by title...").fill(`Copy of ${title}`);
    await page.waitForTimeout(400);
    await expect(page.getByText(`Copy of ${title}`)).toBeVisible();
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
    await detailPanel.getByRole("button", { name: "Edit" }).click();
    await detailPanel.locator('input[name="title"]').fill(updatedTitle);
    await detailPanel.locator('textarea[name="body"]').fill("Activity changed body");
    await detailPanel.getByRole("button", { name: "Save" }).click();

    await expect(detailPanel.getByText("Activity")).toBeVisible();
    await expect(detailPanel.getByText(/updated title, description/i)).toBeVisible({ timeout: 10_000 });
  });

  test("custom fields can be configured and used on tasks", async ({ page }) => {
    const fieldName = uniqueName("Customer");
    const taskTitle = uniqueName("Custom Field Task");
    const fieldValue = uniqueName("Acme Corp");

    await page.goto("/default/settings/custom-fields");
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Customer, Estimate, Release date...").fill(fieldName);
    await page.getByRole("button", { name: "Add field" }).click();
    await page.reload();
    await page.waitForLoadState("networkidle");
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
    const detailPanel = page.locator(".fixed.inset-y-0.right-0");
    await expect(detailPanel.getByText("Custom Fields")).toBeVisible();
    await expect(detailPanel.getByText(fieldName)).toBeVisible();
    await expect(detailPanel.getByText(fieldValue)).toBeVisible();
  });

  test("saved filter presets can be stored and reapplied", async ({ page }) => {
    const presetName = uniqueName("Preset");

    await goToDefaultProject(page);
    await switchToView(page, "list");
    await page.getByPlaceholder("Filter by title...").fill("drag-and-drop");
    await page.getByPlaceholder("Preset name").fill(presetName);
    await page.getByRole("button", { name: "Save preset" }).click();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await switchToView(page, "list");
    await expect(page.getByRole("button", { name: presetName })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByPlaceholder("Filter by title...")).toHaveValue("");

    await page.getByRole("button", { name: presetName }).click();
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

    await page.getByLabel("Open notifications").click();
    await expect(page.getByText("Preferences")).toBeVisible();
    await page.locator('label:has-text("Assignments") input[type="checkbox"]').uncheck();
    await expect(page.locator('label:has-text("Assignments") input[type="checkbox"]')).not.toBeChecked();
    await page.locator('label:has-text("Assignments") input[type="checkbox"]').check();
    await expect(page.locator('label:has-text("Assignments") input[type="checkbox"]')).toBeChecked();
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
      await detailPanel.getByRole("button", { name: "Edit" }).click();
      await detailPanel.locator('select[name="assigneeId"]').selectOption({ label: name });
      await detailPanel.getByRole("button", { name: "Save" }).click();
      await expect(detailPanel.getByText(name)).toBeVisible({ timeout: 10_000 });

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
    const blockerTitle = uniqueName("Blocking Task");
    const blockedTitle = uniqueName("Blocked Task");

    await goToDefaultProject(page);
    await createTask(page, {
      title: blockerTitle,
      dueDate: todayPlus(4),
      status: "To Do",
    });
    await createTask(page, {
      title: blockedTitle,
      dueDate: todayPlus(5),
      status: "In Review",
    });

    await addTaskLink(page, blockerTitle, "blocks", blockedTitle);
    await updateTaskStatusToDoneExpectingError(page, blockedTitle, /blocking tasks are still open/i);
  });

  test("parent links prevent completing a parent with open children", async ({ page }) => {
    const parentTitle = uniqueName("Parent Task");
    const childTitle = uniqueName("Child Task");

    await goToDefaultProject(page);
    await createTask(page, {
      title: parentTitle,
      dueDate: todayPlus(6),
      status: "In Review",
    });
    await createTask(page, {
      title: childTitle,
      dueDate: todayPlus(6),
      status: "To Do",
    });

    await addTaskLink(page, parentTitle, "parent", childTitle);
    await updateTaskStatusToDoneExpectingError(page, parentTitle, /child tasks are still open/i);
  });

  test("child links also prevent completing the linked parent task", async ({ page }) => {
    const parentTitle = uniqueName("Hierarchy Parent");
    const childTitle = uniqueName("Hierarchy Child");

    await goToDefaultProject(page);
    await createTask(page, {
      title: parentTitle,
      dueDate: todayPlus(6),
      status: "In Review",
    });
    await createTask(page, {
      title: childTitle,
      dueDate: todayPlus(6),
      status: "To Do",
    });

    await addTaskLink(page, childTitle, "child", parentTitle);
    await updateTaskStatusToDoneExpectingError(page, parentTitle, /child tasks are still open/i);
  });
});