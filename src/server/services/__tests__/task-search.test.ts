import { describe, expect, it } from "vitest";

import { searchTasks } from "@/server/services/task-search";
import { createPrismaMock, type PrismaMock } from "@/test/prisma-mock";

const PROJECT_ID = "cmab8yxxp0001s0e0a0r0c0h0p0r0j0";

function searchPrismaMock(): PrismaMock {
  const prisma = createPrismaMock();
  prisma.task.count.mockResolvedValue(2);
  prisma.task.findMany.mockResolvedValue([
    {
      id: "cmab8yxxp0003t0a0s0k0o0n0e0x0a0",
      projectId: PROJECT_ID,
      taskNumber: 12,
      title: "Parse a+(b safely",
      body: "The tokenizer must handle a+(b input",
      description: undefined,
      priority: "medium",
      dueDate: new Date("2026-06-01T12:00:00.000Z"),
      createdAt: new Date("2026-05-01T12:00:00.000Z"),
      status: { id: "cmab8yxxp0006s0t0a0t0u0s0s0t0b0", name: "Todo", color: "#3366ff" },
      project: { key: "DEF", slug: "default-project" },
      tags: [
        { tag: { id: "cmab8yxxp0007t0a0g0o0n0e0x0t0b", name: "parser", color: "#ff8800" } },
      ],
      assignee: null,
    },
    {
      id: "cmab8yxxp0004t0a0s0k0o0n0e0x0b0",
      projectId: PROJECT_ID,
      taskNumber: 13,
      title: "Second task",
      body: null,
      description: { text: "rich description" },
      priority: "low",
      dueDate: new Date("2026-06-02T12:00:00.000Z"),
      createdAt: new Date("2026-05-02T12:00:00.000Z"),
      status: { id: "cmab8yxxp0007s0t0a0t0u0s0s0t0c0", name: "Done", color: "#00ff00" },
      project: { key: "DEF", slug: "default-project" },
      tags: [],
      assignee: { id: "cmab8yxxp0008u0s0e0r0a0s0s0i0", name: "Ada", email: "ada@example.com" },
    },
  ]);
  return prisma;
}

describe("searchTasks", () => {
  it("scopes every where clause to the requested project", async () => {
    const prisma = searchPrismaMock();

    const result = await searchTasks(prisma as never, {
      query: "parser",
      projectId: PROJECT_ID,
      statusIds: ["cmab8yxxp0006s0t0a0t0u0s0s0t0b0"],
      priorities: ["medium"],
      tagNames: ["parser"],
      offset: 0,
      limit: 1,
    });

    expect(result.totalHits).toBe(2);

    const countArgs = prisma.task.count.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    const findManyArgs = prisma.task.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(countArgs.where).toMatchObject({ projectId: PROJECT_ID });
    expect(countArgs.where.statusId).toEqual({ in: ["cmab8yxxp0006s0t0a0t0u0s0s0t0b0"] });
    expect(countArgs.where.priority).toEqual({ in: ["medium"] });
    expect(findManyArgs.where).toMatchObject({ projectId: PROJECT_ID });
  });

  it("resolves a task key like DEF-12 into a project key + task number filter", async () => {
    const prisma = searchPrismaMock();

    await searchTasks(prisma as never, { query: "DEF-12", projectId: PROJECT_ID });

    const where = (prisma.task.findMany.mock.calls[0]?.[0] as {
      where: { OR: Array<Record<string, unknown>> };
    }).where;
    expect(where.OR).toContainEqual({
      taskNumber: 12,
      project: { key: "DEF" },
    });
  });

  it("does not treat the query as a regexp: a+(b neither throws nor breaks <mark> highlighting", async () => {
    const prisma = searchPrismaMock();

    const result = await searchTasks(prisma as never, { query: "a+(b", projectId: PROJECT_ID });

    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              title: { contains: "a+(b", mode: "insensitive" },
            }),
          ]),
        }),
      })
    );
    expect(result.hits[0]._formatted?.title).toBe("Parse <mark>a+(b</mark> safely");
    expect(result.hits[0]._formatted?.description).toContain("<mark>a+(b</mark>");
    expect(result.hits[1]._formatted?.title).toBe("Second task");
  });

  it("propagates limit/offset as take/skip", async () => {
    const prisma = searchPrismaMock();

    await searchTasks(prisma as never, { query: "", projectId: PROJECT_ID, offset: 10, limit: 5 });

    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 })
    );

    await searchTasks(prisma as never, { query: "", projectId: PROJECT_ID });

    expect(prisma.task.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 0, take: 20 })
    );
  });

  it("trims the query and skips the OR clause when only whitespace is supplied", async () => {
    const prisma = searchPrismaMock();

    await searchTasks(prisma as never, { query: "   ", projectId: PROJECT_ID });

    const where = (prisma.task.findMany.mock.calls[0]?.[0] as {
      where: { OR?: unknown };
    }).where;
    expect(where.OR).toBeUndefined();
  });
});