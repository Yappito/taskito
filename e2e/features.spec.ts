import { test, expect, Page } from "@playwright/test";

import { clickFirstClickable, createTask, expectTaskDetailOpen, goToDefaultProject, login, switchToView, todayPlus, uniqueName, waitForAppShell } from "./helpers";

/** Navigate to the default project page */
async function goToProject(page: Page) {
  await goToDefaultProject(page);
  // Wait for the project workspace shell to be ready (QuickAdd "+ New Task" button)
  await waitForAppShell(page);
}

/**
 * Click the first graph node that is not covered by a floating panel and
 * return its task title, captured BEFORE the click.
 *
 * Hovering a node re-renders it last in the DOM and focusing relays out the
 * subgraph, so reading the title back from a positional locator after the
 * click can yield a different node than the one that was actually clicked.
 */
async function clickReachableGraphNode(page: Page): Promise<string | null> {
  const nodes = page.locator(".graph-node");
  const count = await nodes.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = nodes.nth(index);
    const title = await candidate.getAttribute("data-task-title").catch(() => null);
    if (!title) {
      continue;
    }
    try {
      // Floating panels (task filters, toolbar, mini-map) cover part of the
      // canvas; a covered click throws after the timeout and we try the next.
      await candidate.click({ timeout: 2_500 });
      return title;
    } catch {
      // Covered by an overlay — try the next candidate.
    }
  }
  throw new Error("No clickable graph node found");
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

    // Fill in description
    const textarea = page.locator('textarea[name="body"]');
    await expect(textarea).toBeVisible();
    await textarea.fill("Test description body content");

    // Save — the update invalidates the task cache, and the visibility
    // assertion below waits for the view-mode panel to refresh.
    await detailPanel.getByRole("button", { name: "Save" }).click();

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

    const searchInput = page.locator('input[placeholder="Search tasks or run a command..."]');
    await expect(searchInput).toBeVisible();
  });

  test("search modal closes with Escape", async ({ page }) => {
    await page.locator("button", { hasText: "Search..." }).click();

    await page.keyboard.press("Escape");

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

    // A single mouse click (like keyboard Enter) toggles focus mode on the
    // clicked node; the toolbar renders "Focus: <full title>" and "Show all".
    const focusedTitle = await clickReachableGraphNode(page);
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

  test("graph title filter narrows the graph to matching tasks", async ({ page }) => {
    await expect(page.locator(".graph-node").first()).toBeVisible({ timeout: 10_000 });
    const initialNodeCount = await page.locator(".graph-node").count();
    // Read every title in one evaluate: hover/focus reorders graph nodes in
    // the DOM, so two positional reads can land on the same node. Pick a
    // comparison title that cannot substring-match the filter in either
    // direction (related tasks share title prefixes).
    const titles = (
      await page.locator(".graph-node").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-task-title")))
    ).filter((title): title is string => Boolean(title));
    const matchingTitle = titles[0];
    const otherTitle = titles.find(
      (title) =>
        title !== matchingTitle &&
        !title.toLowerCase().includes(matchingTitle.toLowerCase()) &&
        !matchingTitle.toLowerCase().includes(title.toLowerCase())
    );

    expect(matchingTitle).toBeTruthy();

    await page.getByPlaceholder("Highlight by title...").fill(matchingTitle!);

    const matchingNode = page.locator(`.graph-node[data-task-title="${matchingTitle}"]`);

    await expect(matchingNode).toHaveAttribute("data-filter-match", "true");

    if (otherTitle) {
      // The title search is applied server-side and narrows the graph (see
      // the filter helper text): non-matching tasks are removed from the
      // result rather than rendered dimmed.
      await expect(page.locator(`.graph-node[data-task-title="${otherTitle}"]`)).toHaveCount(0, { timeout: 10_000 });
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

    await expect(page.getByText("Add drag-and-drop to board")).toBeVisible();
    await expect(page.getByText("Design database schema")).not.toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(1);
  });

  test("list view can filter tasks by tag", async ({ page }) => {
    await page.getByRole("button", { name: "Show filters" }).click();
    await page.getByRole("button", { name: "backend", exact: true }).click();

    await expect(page.getByText("Design database schema")).toBeVisible();
    await expect(page.getByText("Set up project repository")).not.toBeVisible();
  });
});
