import { describe, it, expect } from "vitest";
import { computeGraphLayout } from "@/lib/elk-config";
import { createTimeScale } from "@/lib/date-utils";
import type { GraphTaskData } from "@/lib/types";

describe("elk-config", () => {
  it("returns empty layout for no tasks", async () => {
    const layout = await computeGraphLayout({
      tasks: [],
      links: [],
      timeScale: () => 0,
    });

    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
  });

  it("computes layout with tasks", async () => {
    const tasks: GraphTaskData[] = [
      {
        id: "task1",
        title: "Task 1",
        priority: "medium",
        dueDate: new Date("2025-03-01"),
        statusId: "s1",
        status: { name: "To Do", color: "#3b82f6" },
        tags: [],
      },
      {
        id: "task2",
        title: "Task 2",
        priority: "high",
        dueDate: new Date("2025-03-15"),
        statusId: "s2",
        status: { name: "In Progress", color: "#f59e0b" },
        tags: [],
      },
    ];

    const timeScale = createTimeScale(
      new Date("2025-01-01"),
      new Date("2025-12-31"),
      2000
    );

    const layout = await computeGraphLayout({
      tasks,
      links: [
        {
          id: "link1",
          sourceTaskId: "task1",
          targetTaskId: "task2",
          linkType: "blocks",
        },
      ],
      timeScale,
    });

    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);
    expect(layout.nodes[0].x).toBeDefined();
    expect(layout.nodes[0].y).toBeDefined();
  });

  it("keeps connected tasks closer together than unrelated tasks", async () => {
    const tasks: GraphTaskData[] = [
      {
        id: "task-a",
        title: "Task A",
        priority: "medium",
        dueDate: new Date("2025-03-01"),
        statusId: "s1",
        status: { name: "To Do", color: "#3b82f6" },
        tags: [],
      },
      {
        id: "task-b",
        title: "Task B",
        priority: "medium",
        dueDate: new Date("2025-03-05"),
        statusId: "s1",
        status: { name: "To Do", color: "#3b82f6" },
        tags: [],
      },
      {
        id: "task-c",
        title: "Task C",
        priority: "medium",
        dueDate: new Date("2025-03-03"),
        statusId: "s1",
        status: { name: "To Do", color: "#3b82f6" },
        tags: [],
      },
    ];

    const timeScale = createTimeScale(
      new Date("2025-01-01"),
      new Date("2025-12-31"),
      2000
    );

    const layout = await computeGraphLayout({
      tasks,
      links: [
        {
          id: "link-ab",
          sourceTaskId: "task-a",
          targetTaskId: "task-b",
          linkType: "blocks",
        },
      ],
      timeScale,
    });

    const nodeA = layout.nodes.find((node) => node.id === "task-a");
    const nodeB = layout.nodes.find((node) => node.id === "task-b");
    const nodeC = layout.nodes.find((node) => node.id === "task-c");

    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();
    expect(nodeC).toBeDefined();

    const connectedDistance = Math.abs((nodeA?.y ?? 0) - (nodeB?.y ?? 0));
    const unrelatedDistance = Math.abs((nodeA?.y ?? 0) - (nodeC?.y ?? 0));

    expect(connectedDistance).toBeLessThan(unrelatedDistance);
  });
});
