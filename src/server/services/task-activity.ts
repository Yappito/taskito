import { Prisma, type TaskActivityAction } from "@prisma/client";

import { prisma } from "@/lib/prisma";

interface CreateTaskActivityInput {
  taskId: string;
  actorId?: string | null;
  action: TaskActivityAction;
  details?: Prisma.InputJsonValue;
}

export async function createTaskActivity(input: CreateTaskActivityInput) {
  return prisma.activityEvent.create({
    data: {
      taskId: input.taskId,
      actorId: input.actorId ?? null,
      action: input.action,
      details: input.details,
    },
  });
}