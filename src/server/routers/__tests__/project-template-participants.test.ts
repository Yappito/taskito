import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCallerFactory } from "@/server/trpc";
import { projectRouter } from "@/server/routers/project";
import { createPrismaMock } from "@/test/prisma-mock";

const createCaller = createCallerFactory(projectRouter);

const PROJECT_ID = "cmab8yxxp0101i7p4k8n2v3q4";
const USER_ID = "cmab8yxxp0102i7p4k8n2v3q5";
const PARTICIPANT_ID = "cmab8yxxp0103i7p4k8n2v3q6";

describe("project template participants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists participantIds in saved task templates", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, role: "member" });
    prisma.user.findUniqueOrThrow.mockResolvedValue({ id: USER_ID, role: "admin" });
    prisma.user.findMany.mockResolvedValue([{ id: PARTICIPANT_ID, role: "admin", projectMemberships: [] }]);
    prisma.project.findUniqueOrThrow.mockResolvedValue({ settings: {} });
    prisma.project.update.mockResolvedValue({
      settings: {
        taskTemplates: [
          {
            id: "template-1",
            name: "Participant template",
            title: "Template title",
            participantIds: [PARTICIPANT_ID],
          },
        ],
      },
    });
    prisma.projectMember.findUnique.mockResolvedValue({ role: "owner" });

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID, role: "member" } } as never,
    });

    const result = await caller.saveTemplate({
      projectId: PROJECT_ID,
      name: "Participant template",
      title: "Template title",
      priority: "none",
      participantIds: [PARTICIPANT_ID],
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [PARTICIPANT_ID] } },
      })
    );
    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settings: expect.objectContaining({
            taskTemplates: [
              expect.objectContaining({
                participantIds: [PARTICIPANT_ID],
              }),
            ],
          }),
        }),
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        participantIds: [PARTICIPANT_ID],
      })
    );
  });
});
