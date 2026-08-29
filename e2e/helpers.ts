import { expect, type Locator, type Page } from "@playwright/test";

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function uniqueName(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

export function todayPlus(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().split("T")[0];
}

/**
 * Wait for the project workspace shell to be ready.
 *
 * The project page no longer renders an <h1> (the project name moved into the
 * dashboard header as a link), so wait for the QuickAdd "+ New Task" button,
 * which is always rendered above the view content once the project has loaded
 * and is not tied to any specific view.
 */
export async function waitForAppShell(page: Page) {
  await expect(page.getByRole("button", { name: "+ New Task" })).toBeVisible({ timeout: 15_000 });
}

export async function login(page: Page, email = "admin@taskito.local", password = "taskito-demo-2026") {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await expect(page.locator('input[name="email"]')).toBeVisible({ timeout: 15_000 });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    try {
      await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 8_000 });
      return;
    } catch (error) {
      const leakedCredentialsInUrl = page.url().includes("/login?") &&
        (page.url().includes("email=") || page.url().includes("password="));

      if (leakedCredentialsInUrl && attempt < 2) {
        continue;
      }

      const hasInvalidCredentials = await page
        .getByText("Invalid email or password")
        .isVisible()
        .catch(() => false);

      if (hasInvalidCredentials || attempt === 2) {
        throw error;
      }
    }
  }
}

export async function goToDefaultProject(page: Page, search = "") {
  await page.goto(`/default${search}`, { waitUntil: "domcontentloaded" });
  await waitForAppShell(page);
}

export async function switchToView(page: Page, view: "dashboard" | "list" | "board" | "calendar" | "gantt" | "sprint" | "graph" | "archive") {
  await page.getByRole("button", { name: view === "gantt" ? "Gantt" : view, exact: true }).click();
}

export async function createTask(page: Page, options: {
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
  // The QuickAdd dialog exposes an accessible name via its Dialog title, so
  // locators can be scoped to the dialog (avoids "Create Task"/"Cancel"
  // substring collisions with page chrome and task-card buttons).
  const dialog = page.getByRole("dialog", { name: "New Task" });
  await page.getByRole("button", { name: /New Task/i }).click();
  await expect(dialog).toBeVisible();

  if (options.templateToUse) {
    await page.locator('select').first().selectOption({ label: options.templateToUse });
    await page.waitForTimeout(200);
  }

  // Fill the title, then WAIT for its controlled value to commit before
  // touching another field. On a cold (not-yet-hydrated) page the title
  // auto-focus effect and React's controlled-input reconciliation can still
  // be settling; filling the body immediately afterwards then occasionally
  // raced the title's onChange and the title state committed as
  // "<title><body>" (intermittent — the saved task/template title came out
  // concatenated). Asserting the committed value pins the title before the
  // next fill and removes the race.
  const titleInput = page.getByPlaceholder("Task title...");
  await titleInput.fill(options.title);
  await expect(titleInput).toHaveValue(options.title);

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
    await dialog.locator("label", { hasText: tagName }).locator('input[type="checkbox"]').check();
  }

  for (const [fieldName, value] of Object.entries(options.customFieldValues ?? {})) {
    const fieldLabel = dialog.locator("label", {
      hasText: new RegExp(`^${escapeRegex(fieldName)}(?:\\s*\\*)?$`),
    }).first();
    const input = fieldLabel
      .locator("xpath=..")
      .locator("input:not([type=hidden]), select")
      .first();
    await input.fill(value);
  }

  if (options.saveAsTemplate) {
    await dialog.locator("label", { hasText: "Save this draft as a reusable template" }).locator('input[type="checkbox"]').check();
    await dialog.getByPlaceholder("Template name").fill(options.saveAsTemplate);
  }

  await dialog.getByRole("button", { name: "Create Task" }).click();
  await page.waitForTimeout(1000);

  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }

  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
}

export async function openBoardTaskDetail(page: Page, title: string) {
  await switchToView(page, "board");
  await page.getByPlaceholder("Filter by title...").fill(title);
  await expect(page.getByRole("heading", { name: title }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("heading", { name: title }).first().click();
  await expect(taskDetailPanel(page)).toBeVisible({ timeout: 10_000 });
}

export function taskDetailPanel(page: Page): Locator {
  return page.locator(".fixed.inset-y-0.right-0").first();
}

/**
 * Assert the task detail side panel is open.
 *
 * The panel header renders a "Task Detail" eyebrow label, but task cards whose
 * titles merely contain "Task Detail" can be visible on the page at the same
 * time, so the label is matched exactly inside the panel.
 */
export async function expectTaskDetailOpen(page: Page, timeout = 10_000): Promise<void> {
  const detail = taskDetailPanel(page);
  await expect(detail).toBeVisible({ timeout });
  await expect(detail.getByText("Task Detail", { exact: true })).toBeVisible({ timeout });
}

/**
 * Click the first element matching `locator` that is not covered by another
 * element. Floating panels (task filters, toolbar, mini-map) overlay parts of
 * the graph canvas, so fixed indices can be unclickable; Playwright rejects
 * covered clicks, and we walk candidates until one lands.
 */
export async function clickFirstClickable(page: Page, locator: Locator, timeout = 2_500): Promise<Locator> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    try {
      await candidate.click({ timeout });
      return candidate;
    } catch {
      // Covered by an overlay — try the next candidate.
    }
  }
  throw new Error(`No clickable element found for locator: ${locator}`);
}

export async function closeTaskDetail(page: Page) {
  const detail = taskDetailPanel(page);
  await detail.getByRole("button", { name: "Close task detail" }).click();
  await expect(detail).not.toBeVisible({ timeout: 10_000 });
}

export async function dragTaskDetailSection(page: Page, sourceSectionId: string, targetSectionId: string) {
  const detail = taskDetailPanel(page);
  const sourceSection = detail.locator(`[data-task-detail-section="${sourceSectionId}"]`).first();
  const targetSection = detail.locator(`[data-task-detail-section="${targetSectionId}"]`).first();
  const sourceHandle = sourceSection.getByRole("button", { name: /Reorder .* section/ }).first();
  await sourceHandle.scrollIntoViewIfNeeded();
  await targetSection.scrollIntoViewIfNeeded();
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetSection.boundingBox();

  if (!sourceBox || !targetBox) {
    throw new Error("Unable to determine task detail section drag coordinates");
  }

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + Math.min(8, Math.max(4, targetBox.height / 4)), { steps: 16 });
  await page.mouse.up();
}

export async function createSprint(page: Page, name: string, goal: string, memberCount = 0) {
  await switchToView(page, "sprint");
  await page.getByRole("button", { name: "Create Sprint" }).click();
  const createDialog = page.getByRole("dialog");
  await expect(createDialog.getByRole("heading", { name: "Create Sprint" })).toBeVisible();
  await createDialog.locator('input[name="name"]').fill(name);
  await createDialog.locator('input[name="goal"]').fill(goal);
  const memberCheckboxes = createDialog.locator('input[name="memberIds"]');
  const available = await memberCheckboxes.count();
  for (let index = 0; index < Math.min(memberCount, available); index += 1) {
    await memberCheckboxes.nth(index).check();
  }
  await createDialog.getByRole("button", { name: "Create Sprint", exact: true }).click();
  await expect(page.getByText(`Sprint “${name}” created.`)).toBeVisible({ timeout: 10_000 });
  return page.getByLabel("Select Sprint");
}
