import { expect, type Locator, type Page } from "@playwright/test";

export function uniqueName(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

export function todayPlus(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().split("T")[0];
}

async function waitForAppShell(page: Page) {
  await expect(page.locator("h1").first()).toBeVisible({ timeout: 15_000 });
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
}) {
  await page.getByRole("button", { name: /New Task/i }).click();
  await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
  await page.getByPlaceholder("Task title...").fill(options.title);

  if (options.description) {
    await page.getByPlaceholder("Add task details...").fill(options.description);
  }

  if (options.dueDate) {
    await page.locator('input[name="dueDate"]').fill(options.dueDate);
  }

  if (options.status) {
    await page.locator('select[name="statusId"]').selectOption({ label: options.status });
  }

  if (options.priority) {
    await page.locator('select[name="priority"]').selectOption(options.priority);
  }

  if (options.assignee) {
    await page.locator('select[name="assigneeId"]').selectOption({ label: options.assignee });
  }

  await page.getByRole("button", { name: "Create Task" }).click();
  await expect(page.getByRole("heading", { name: "New Task" })).not.toBeVisible({ timeout: 10_000 });
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

export async function closeTaskDetail(page: Page) {
  await taskDetailPanel(page).getByRole("button", { name: "Close task detail" }).click();
  await expect(page.getByText("Task Detail")).not.toBeVisible({ timeout: 10_000 });
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
