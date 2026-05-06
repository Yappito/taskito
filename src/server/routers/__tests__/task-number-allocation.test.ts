import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import { createTaskWithNextNumber } from "@/server/routers/task";

describe("task number allocation", () => {
  it("retries when project task number allocation hits a unique conflict", async () => {
    const tx = {
      task: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ taskNumber: 7 })
          .mockResolvedValueOnce({ taskNumber: 8 }),
      },
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as const;

    const create = vi
      .fn()
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("duplicate task number", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["projectId", "taskNumber"] },
      }))
      .mockResolvedValueOnce({ id: "task-9", taskNumber: 9 });

    const result = await createTaskWithNextNumber(tx as never, "project-1", (_innerTx, taskNumber) => create(taskNumber));

    expect(create).toHaveBeenNthCalledWith(1, 8);
    expect(create).toHaveBeenNthCalledWith(2, 9);
    expect(tx.$transaction).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: "task-9", taskNumber: 9 });
  });

  it("does not swallow unrelated create failures", async () => {
    const tx = {
      task: {
        findFirst: vi.fn().mockResolvedValue({ taskNumber: 3 }),
      },
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as const;

    const create = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(createTaskWithNextNumber(tx as never, "project-1", (_innerTx, taskNumber) => create(taskNumber))).rejects.toThrow("boom");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(4);
  });
});
