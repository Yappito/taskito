import { test, expect } from "@playwright/test";

import { createTask, expectTaskDetailOpen, goToDefaultProject, login, openBoardTaskDetail, switchToView, todayPlus, uniqueName } from "./helpers";

test.describe("Workflow feature coverage", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("dashboard supports custom dashboards with metric widgets", async ({ page }) => {
    await goToDefaultProject(page);
    await switchToView(page, "dashboard");

    await expect(page.getByRole("heading", { name: "Custom dashboards" })).toBeVisible();

    const dashboardName = uniqueName("Team Dashboard");
    const widgetTitle = uniqueName("Task count widget");

    // Start a fresh dashboard regardless of dashboards left by previous runs
    // (the view auto-selects the first existing dashboard on load).
    await page.getByRole("button", { name: "New dashboard", exact: true }).click();

    const createPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Create dashboard", exact: true }) });
    await createPanel.locator("input").first().fill(dashboardName);
    await createPanel.getByRole("button", { name: "Create dashboard", exact: true }).click();

    // Creating selects the dashboard and flips the side panel to permissions.
    await expect(page.getByRole("heading", { name: "Dashboard permissions" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("option", { hasText: dashboardName }).first()).toBeAttached();

    // Add a metric widget counting all active project tasks.
    const widgetPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Add widget", exact: true }) });
    await widgetPanel.locator("input").first().fill(widgetTitle);
    await widgetPanel.locator("select").first().selectOption({ label: "Metric" });
    await widgetPanel.getByRole("button", { name: "Add widget", exact: true }).click();

    const widgetCard = page.locator("section").filter({ has: page.getByRole("heading", { name: widgetTitle }) });
    await expect(widgetCard).toBeVisible({ timeout: 10_000 });
    await expect(widgetCard.locator(".text-5xl")).toHaveText(/\d+/);
  });

  test("calendar view shows month navigation and due-date tasks", async ({ page }) => {
    await goToDefaultProject(page);
    await switchToView(page, "calendar");

    const heading = page.getByRole("heading", { level: 2 });
    await expect(heading).toBeVisible();
    await expect(page.getByText("Sun")).toBeVisible();
    await expect(page.getByText("Mon")).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeVisible();

    const initialTitle = await heading.textContent();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(heading).not.toHaveText(initialTitle ?? "", { timeout: 10_000 });
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(heading).toBeVisible();

    const calendarTasks = page.locator("button").filter({ has: page.locator("span.h-2.w-2.rounded-full") });
    await expect(calendarTasks.first()).toBeVisible();
  });

  test("gantt view renders bars without overflow and opens task detail", async ({ page }) => {
    await goToDefaultProject(page);
    await switchToView(page, "gantt");

    await expect(page.getByText("Gantt timeline")).toBeVisible();
    const bars = page.locator('button[title][aria-label^="Open "]');
    await expect(bars.first()).toBeVisible();

    const overflowCount = await page.evaluate(() => {
      const barElements = Array.from(document.querySelectorAll('button[title][aria-label^="Open "]')) as HTMLButtonElement[];
      return barElements.filter((bar) => bar.scrollWidth > bar.clientWidth + 1).length;
    });
    expect(overflowCount).toBe(0);

    await bars.first().click();
    await expectTaskDetailOpen(page);
  });

  test("sprint view can create and advance a sprint lifecycle", async ({ page }) => {
    const sprintName = uniqueName("Sprint");
    const sprintGoal = uniqueName("Goal");

    await goToDefaultProject(page);
    await switchToView(page, "sprint");

    await page.getByRole("button", { name: "Create Sprint" }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog.getByRole("heading", { name: "Create Sprint" })).toBeVisible();
    await createDialog.locator('input[name="name"]').fill(sprintName);
    await createDialog.locator('input[name="goal"]').fill(sprintGoal);
    await createDialog.getByRole("button", { name: "Create Sprint", exact: true }).click();

    const sprintPicker = page.getByLabel("Select Sprint");
    await expect(sprintPicker).toContainText(sprintName, { timeout: 10_000 });
    await sprintPicker.selectOption({ label: `${sprintName} (planning)` });
    await expect(page.getByRole("heading", { name: sprintName })).toBeVisible();
    await expect(page.getByText(sprintGoal)).toBeVisible();

    await page.getByRole("button", { name: "Start" }).click();
    await expect(sprintPicker).toContainText(`${sprintName} (active)`, { timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Start" })).toBeDisabled();
    await page.getByRole("button", { name: "Complete" }).click();
    await expect(sprintPicker).toContainText(`${sprintName} (completed)`, { timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Complete" })).toBeDisabled();
  });

  test("task recurrence can be enabled and removed", async ({ page }) => {
    const title = uniqueName("Recurring Task");

    await goToDefaultProject(page);
    await createTask(page, {
      title,
      dueDate: todayPlus(7),
      status: "To Do",
    });

    await openBoardTaskDetail(page, title);

    const recurrenceSection = page.locator("section").filter({ has: page.getByText("Recurring task") }).first();
    await expect(recurrenceSection).toBeVisible();
    await recurrenceSection.locator("select").selectOption("weekly");
    await recurrenceSection.locator('input[type="number"]').fill("2");
    await recurrenceSection.getByRole("button", { name: "Repeat" }).click();
    await expect(recurrenceSection.getByRole("button", { name: "Stop repeating" })).toBeVisible({ timeout: 10_000 });

    await recurrenceSection.getByRole("button", { name: "Stop repeating" }).click();
    await expect(recurrenceSection.getByRole("button", { name: "Repeat" })).toBeVisible({ timeout: 10_000 });
  });

  test("time tracking supports manual logs and timer toggling", async ({ page }) => {
    const title = uniqueName("Time Task");
    const note = uniqueName("Manual note");

    await goToDefaultProject(page);
    await createTask(page, {
      title,
      dueDate: todayPlus(5),
      status: "To Do",
    });

    await openBoardTaskDetail(page, title);

    const timeSection = page.locator("section").filter({ has: page.getByText("Time tracking") }).first();
    await expect(timeSection).toBeVisible();
    await timeSection.locator('input[type="number"]').fill("15");
    await timeSection.getByPlaceholder("Manual log note").fill(note);
    await timeSection.getByRole("button", { name: "Add minutes" }).click();
    await expect(timeSection.getByText(note)).toBeVisible({ timeout: 10_000 });

    await timeSection.getByRole("button", { name: "Start timer" }).click();
    await expect(timeSection.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: 10_000 });
    await timeSection.getByRole("button", { name: /Stop/ }).click();
    await expect(timeSection.getByRole("button", { name: "Start timer" })).toBeVisible({ timeout: 10_000 });
  });

  test("automation settings can create, disable, and delete a rule", async ({ page }) => {
    const ruleName = uniqueName("Automation Rule");

    await page.goto("/default/settings/automation");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Workflow automation" })).toBeVisible();

    await page.locator('input[name="name"]').fill(ruleName);
    await page.locator('select[name="trigger"]').selectOption("commentAdded");
    await page.locator('select[name="action"]').selectOption("addComment");
    await page.locator('textarea[name="triggerCondition"]').fill("{}");
    await page.locator('textarea[name="actionPayload"]').fill('{"content":"Automation ran from Playwright"}');
    await page.getByRole("button", { name: "Create rule" }).click();

    const ruleCard = page.locator("div").filter({ has: page.getByRole("heading", { name: ruleName }) }).first();
    await expect(ruleCard).toBeVisible({ timeout: 10_000 });
    await ruleCard.getByRole("button", { name: "Disable" }).click();
    await expect(ruleCard.getByRole("button", { name: "Enable" })).toBeVisible({ timeout: 10_000 });
    await ruleCard.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("heading", { name: ruleName })).not.toBeVisible({ timeout: 10_000 });
  });

  test("project AI launcher opens chat shell with controls", async ({ page }) => {
    await goToDefaultProject(page);
    await page.getByRole("button", { name: "Project AI" }).click();

    await expect(page.getByRole("heading", { name: /AI workspace/i })).toBeVisible();
    await expect(page.locator("label", { hasText: "Provider" }).first()).toBeVisible();
    await expect(page.locator("label", { hasText: "Mode" }).first()).toBeVisible();
    await expect(page.locator("label", { hasText: "Granted permissions" }).first()).toBeVisible();
    await expect(page.locator("label", { hasText: "Chat history" }).first()).toBeVisible();
    await expect(page.locator('select').filter({ has: page.locator('option[value=""]') }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
  });

  test("url query params can select a view and deep-link a task", async ({ page }) => {
    await goToDefaultProject(page, "?view=calendar");
    await expect(page.getByText("Calendar view by task due date.")).toBeVisible();

    await goToDefaultProject(page, "?view=board");
    const taskId = await page.locator("[data-board-task-id]").first().getAttribute("data-board-task-id");
    expect(taskId).toBeTruthy();

    await goToDefaultProject(page, `?task=${taskId}`);
    await expectTaskDetailOpen(page);
  });
});
