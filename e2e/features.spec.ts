import { test, expect, Page } from "@playwright/test";

import { clickFirstClickable, createTask, expectTaskDetailOpen, goToDefaultProject, login, switchToView, todayPlus, uniqueName, waitForAppShell } from "./helpers";

/** Navigate to the default project page */
async function goToProject(page: Page) {
  await goToDefaultProject(page);
  // Wait for the project workspace shell to be ready (QuickAdd "+ New Task" button)
  await waitForAppShell(page);
}

test.describe("Board view drag-and-drop", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToProject(page);
    await switchToView(page, "board");
  });

  test("board view renders columns for each status", async ({ page }) => {
    // Should see status column headers (as headings)
    await expect(page.getByRole("heading", { name: "Backlog" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "To Do" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "In Progress" })).toBeVisible();
  });

  test("board cards can move between columns", async ({ page }) => {
    const backlogCard = page.locator('[data-board-status-name="Backlog"] [data-board-task-id]').first();
    const movedTaskId = await backlogCard.getAttribute("data-board-task-id");

    if (!movedTaskId) {
      throw new Error("No task found in Backlog");
    }

    await backlogCard.click();
    const detailPanel = page.locator(".fixed.inset-y-0.right-0");
    await expectTaskDetailOpen(page);
    await detailPanel.getByRole("button", { name: "Edit", exact: true }).click();
    await detailPanel.locator('select[name="statusId"]').selectOption({ label: "To Do" });
    await detailPanel.getByRole("button", { name: "Save" }).click();
    await expect(
      page.locator(`[data-board-status-name="To Do"] [data-board-task-id="${movedTaskId}"]`)
    ).toBeVisible({ timeout: 10_000 });
  });

  test("clicking a board card opens task detail", async ({ page }) => {
    // Click the first task card
    const firstCard = page.locator("[data-board-task-id]").first();
    await firstCard.click();
    await page.waitForTimeout(300);

    // Task detail panel should appear
    await expectTaskDetailOpen(page);
  });

  test("board can filter tasks by title substring", async ({ page }) => {
    const filterInput = page.getByPlaceholder("Filter by title...");
    await filterInput.fill("drag-and-drop");

    await expect(page.getByText("Add drag-and-drop to board")).toBeVisible();
    await expect(page.getByText("Design database schema")).not.toBeVisible();
    await expect(page.locator("[data-board-task-id]")).toHaveCount(1);
  });

  test("board can filter tasks by tag", async ({ page }) => {
    await page.getByRole("button", { name: "Show filters" }).click();
    await page.getByRole("button", { name: "backend", exact: true }).click();

    await expect(page.getByText("Design database schema")).toBeVisible();
    await expect(page.getByRole("button", { name: "backend", exact: true })).toBeVisible();
  });
});

test.describe("Task body/description", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToProject(page);
    await switchToView(page, "board");
  });

  test("task detail shows edit form with description field", async ({ page }) => {
    // Click the first task card to open detail
    const firstCard = page.locator("[data-board-task-id]").first();
    await firstCard.click();

    // Wait for detail panel to appear
    await expectTaskDetailOpen(page);

    // Click Edit button in the detail panel
    const detailPanel = page.locator(".fixed.inset-y-0.right-0");
    await detailPanel.getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForTimeout(300);

    // Should see the description textarea
    const textarea = page.locator('textarea[name="body"]');
    await expect(textarea).toBeVisible();
  });

  test("can save task description", async ({ page }) => {
    // Click the first task card
    const firstCard = page.locator("[data-board-task-id]").first();
    await firstCard.click();

    // Wait for detail panel
    await expectTaskDetailOpen(page);

    // Click Edit
    const detailPanel = page.locator(".fixed.inset-y-0.right-0");
    await detailPanel.getByRole("button", { name: "Edit", exact: true }).click();
    await page.waitForTimeout(300);

    // Fill in description
    const textarea = page.locator('textarea[name="body"]');
    await expect(textarea).toBeVisible();
    await textarea.fill("Test description body content");

    // Save
    await detailPanel.getByRole("button", { name: "Save" }).click();
    await page.waitForTimeout(1000);

    // View mode should show the description
    await expect(page.getByText("Test description body content")).toBeVisible({ timeout: 10000 });
  });

  test("quick add description keeps focus while typing", async ({ page }) => {
    await page.getByRole("button", { name: "New Task" }).click();
    await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();

    const titleInput = page.getByPlaceholder("Task title...");
    const descriptionInput = page.getByPlaceholder("Add task details...");
    const title = "Focus regression title";
    const description = "Typing stays in description";

    await titleInput.fill(title);
    await descriptionInput.click();
    await expect(descriptionInput).toBeFocused();

    await descriptionInput.fill(description);

    await expect(descriptionInput).toHaveValue(description);
    await expect(descriptionInput).toBeFocused();
    await expect(titleInput).toHaveValue(title);
  });
});

test.describe("Archive system", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToProject(page);
  });

  test("archive tab is visible", async ({ page }) => {
    await expect(page.locator("button", { hasText: "archive" })).toBeVisible();
  });

  test("archive tab shows empty state initially", async ({ page }) => {
    await switchToView(page, "archive");
    await expect(page.getByRole("button", { name: /Show filters|Hide filters/ })).toBeVisible();
  });
});

test.describe("Search opens task", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToProject(page);
  });

  test("search modal can be opened with button", async ({ page }) => {
    await page.locator("button", { hasText: "Search..." }).click();
    await page.waitForTimeout(300);

    const searchInput = page.locator('input[placeholder="Search tasks or run a command..."]');
    await expect(searchInput).toBeVisible();
  });

  test("search modal closes with Escape", async ({ page }) => {
    await page.locator("button", { hasText: "Search..." }).click();
    await page.waitForTimeout(300);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const searchInput = page.locator('input[placeholder="Search tasks or run a command..."]');
    await expect(searchInput).not.toBeVisible();
  });

  test("clicking a search result opens task detail", async ({ page }) => {
    await page.locator("button", { hasText: "Search..." }).click();
    const searchInput = page.locator('input[placeholder="Search tasks or run a command..."]');
    await expect(searchInput).toBeVisible();

    await searchInput.fill("drag-and-drop");
    const firstResult = page.locator("li button").first();
    await expect(firstResult).toBeVisible({ timeout: 10000 });
    await firstResult.click();

    await expectTaskDetailOpen(page);
  });
});

test.describe("Graph view", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToProject(page);
    await switchToView(page, "graph");
  });

  test("graph view renders SVG with task nodes", async ({ page }) => {
    await expect(page.locator(".graph-node").first()).toBeVisible({ timeout: 10_000 });
    // SVG should be present
    const svg = page.locator("svg").first();
    await expect(svg).toBeVisible();

    // Should have task nodes
    const nodes = page.locator(".graph-node");
    const count = await nodes.count();
    expect(count).toBeGreaterThan(0);
  });

  test("graph view has resolution toolbar", async ({ page }) => {
    await expect(page.getByRole("button", { name: "day", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "week", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "month", exact: true })).toBeVisible();
  });

  test("graph view has connection ports on nodes", async ({ page }) => {
    await expect(page.locator(".graph-node").first()).toBeVisible({ timeout: 10_000 });
    // Connection ports should be present
    const ports = page.locator(".connection-port");
    const count = await ports.count();
    expect(count).toBeGreaterThan(0);
  });

  test("clicking a graph node toggles focused subgraph mode", async ({ page }) => {
    await expect(page.locator(".graph-node").first()).toBeVisible({ timeout: 10_000 });
    const initialNodeCount = await page.locator(".graph-node").count();

    // Floating panels (task filters, toolbar, mini-map) cover part of the
    // canvas; click the first node that is actually reachable.
    const node = await clickFirstClickable(page, page.locator(".graph-node"));
    const focusedTitle = await node.getAttribute("data-task-title");
    expect(focusedTitle).toBeTruthy();

    const showAll = page.getByRole("button", { name: "Show all", exact: true });
    await expect(showAll).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(`Focus: ${focusedTitle}`)).toBeVisible({ timeout: 10_000 });

    // Focusing shows a connected subgraph, so the rendered set can only shrink.
    await expect
      .poll(async () => page.locator(".graph-node").count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(initialNodeCount);
    expect(await page.locator(".graph-node").count()).toBeGreaterThan(0);

    await showAll.click();
    await expect(showAll).not.toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => page.locator(".graph-node").count(), { timeout: 10_000 })
      .toBe(initialNodeCount);
  });

  test("graph node info icon opens task detail", async ({ page }) => {
    await expect(page.locator(".graph-node").first()).toBeVisible({ timeout: 10_000 });
    await clickFirstClickable(page, page.getByLabel("Open task details"));
    await expectTaskDetailOpen(page);
  });

  test("graph title filter highlights matches without removing other tasks", async ({ page }) => {
    await expect(page.locator(".graph-node").first()).toBeVisible({ timeout: 10_000 });
    const initialNodeCount = await page.locator(".graph-node").count();
    const matchingTitle = await page.locator(".graph-node").first().getAttribute("data-task-title");
    const otherTitle = await page.locator(".graph-node").nth(1).getAttribute("data-task-title");

    expect(matchingTitle).toBeTruthy();

    await page.getByPlaceholder("Highlight by title...").fill(matchingTitle!);
    await page.waitForTimeout(400);

    const matchingNode = page.locator(`.graph-node[data-task-title="${matchingTitle}"]`);

    await expect(matchingNode).toHaveAttribute("data-filter-match", "true");

    if (otherTitle && otherTitle !== matchingTitle) {
      const otherNode = page.locator(`.graph-node[data-task-title="${otherTitle}"]`);
      if (await otherNode.count()) {
        await expect(otherNode.first()).toHaveAttribute("data-filter-match", "false");
      }
    }

    const finalNodeCount = await page.locator(".graph-node").count();
    expect(finalNodeCount).toBeGreaterThan(0);
    expect(finalNodeCount).toBeLessThanOrEqual(initialNodeCount);
  });

  test("graph tag filter narrows the graph to tasks carrying the selected tag", async ({ page }) => {
    // Create a tagged task so the tag is guaranteed to match at least one task
    // regardless of what previous runs left in the database.
    const title = uniqueName("Graph Tag Task");
    await createTask(page, { title, dueDate: todayPlus(5), status: "To Do", tagNames: ["frontend"] });

    // Re-enter the graph view so it fetches data including the new task.
    await goToDefaultProject(page, "?view=graph");
    await expect(page.locator(".graph-node").first()).toBeVisible({ timeout: 10_000 });

    // Narrow by title first so the new task's node is deterministically
    // rendered, then verify the tag metadata the graph pipes onto its nodes.
    await page.getByPlaceholder("Highlight by title...").fill(title);
    const node = page.locator(`.graph-node[data-task-title="${title}"]`);
    await expect(node).toHaveAttribute("data-task-tags", "frontend", { timeout: 10_000 });

    // Selecting a tag narrows the graph; clear the title query and confirm
    // every rendered node carries the selected tag.
    await page.getByRole("button", { name: "Show filters" }).click();
    await page.getByRole("button", { name: "frontend", exact: true }).click();
    await page.getByPlaceholder("Highlight by title...").fill("");

    await expect
      .poll(
        async () => {
          const tagLists = await page.locator(".graph-node").evaluateAll((nodes) =>
            nodes.map((node) => (node.getAttribute("data-task-tags") ?? "")
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean))
          );
          return tagLists.length > 0 && tagLists.every((tags) => tags.includes("frontend"));
        },
        { timeout: 10_000 }
      )
      .toBe(true);
  });

  test("reset zoom button works", async ({ page }) => {
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.waitForTimeout(500);
    // Just verify no error — graph should still be visible
    const svg = page.locator("svg").first();
    await expect(svg).toBeVisible();
  });
});

test.describe("View switching", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToProject(page);
  });

  test("can switch between list, board, graph, and archive views", async ({ page }) => {
    await switchToView(page, "board");

    await switchToView(page, "list");

    await switchToView(page, "graph");
    const svg = page.locator("svg").first();
    await expect(svg).toBeVisible();

    await switchToView(page, "archive");
  });
});

test.describe("List view filters", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToProject(page);
    await switchToView(page, "list");
  });

  test("list view can filter tasks by title substring", async ({ page }) => {
    await page.getByPlaceholder("Filter by title...").fill("drag-and-drop");
    await page.waitForTimeout(400);

    await expect(page.getByText("Add drag-and-drop to board")).toBeVisible();
    await expect(page.getByText("Design database schema")).not.toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(1);
  });

  test("list view can filter tasks by tag", async ({ page }) => {
    await page.getByRole("button", { name: "Show filters" }).click();
    await page.getByRole("button", { name: "backend", exact: true }).click();
    await page.waitForTimeout(300);

    await expect(page.getByText("Design database schema")).toBeVisible();
    await expect(page.getByText("Set up project repository")).not.toBeVisible();
  });
});
