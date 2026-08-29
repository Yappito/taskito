import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { automationRouter } from "@/server/routers/automation";
import { callerFor, memberOf, type WiredActor } from "@/test/actors";

const PROJECT_A = "cmab8yxxp0001i7p4k8n2v3q4";
const PROJECT_B = "cmab8yxxp0002i7p4k8n2v3q5";
const STATUS_A = "cmab8yxxp0003i7p4k8n2v3q6";
const STATUS_B = "cmab8yxxp0004i7p4k8n2v3q7";
const TASK_A = "cmab8yxxp0005i7p4k8n2v3q8";
const TASK_B = "cmab8yxxp0006i7p4k8n2v3q9";
const RULE_ID = "cmab8yxxp0007i7p4k8n2v3qa";
const TAG_A = "cmab8yxxp0008i7p4k8n2v3qb";
const ASSIGNee_A = "cmab8yxxp0009i7p4k8n2v3qc";

function wireProjectScopedLookups(actor: WiredActor) {
  // Statuses and tags are validated through their project relation.
  actor.prisma.workflowStatus.findFirst.mockImplementation(async (args?: { where?: { id?: string; projectId?: string } }) => {
    const where = args?.where ?? {};
    if (where.id === STATUS_A && where.projectId === PROJECT_A) return { id: STATUS_A };
    if (where.id === STATUS_B && where.projectId === PROJECT_B) return { id: STATUS_B };
    return null;
  });
  actor.prisma.tag.findFirst.mockImplementation(async (args?: { where?: { id?: string; projectId?: string } }) => {
    const where = args?.where ?? {};
    if (where.id === TAG_A && where.projectId === PROJECT_A) return { id: TAG_A };
    return null;
  });
  actor.prisma.task.findFirst.mockImplementation(async (args?: { where?: { id?: string; projectId?: string } }) => {
    const where = args?.where ?? {};
    if (where.id === TASK_A && where.projectId === PROJECT_A) return { id: TASK_A };
    if (where.id === TASK_B && where.projectId === PROJECT_B) return { id: TASK_B };
    return null;
  });
  // Assignees must be members of the rule's project.
  actor.prisma.projectMember.findFirst.mockImplementation(async (args?: { where?: { projectId?: string; userId?: string } }) => {
    const where = args?.where ?? {};
    if (where?.projectId === PROJECT_A && where?.userId === ASSIGNee_A) return { userId: ASSIGNee_A };
    return null;
  });
}

describe("automation router (H3: confused-deputy hardening)", () => {
  let actor: WiredActor;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createAutomationManagerWith(grants: Array<{ permission: string; allowed: boolean }>) {
    actor = memberOf({
      userId: "cmab8yxxp0000m0e0m0b0e0r0u0s0e0",
      projects: { [PROJECT_A]: "member" },
      grants: grants.map((grant) => ({ ...grant, projectId: PROJECT_A })) as never,
    });
    wireProjectScopedLookups(actor);
    actor.prisma.automationRule.create.mockResolvedValue({ id: RULE_ID });
    actor.prisma.automationRule.findUniqueOrThrow.mockResolvedValue({
      id: RULE_ID,
      projectId: PROJECT_A,
      action: "moveStatus",
      createdByUserId: null,
    });
    return callerFor(automationRouter, actor.prisma, actor.sessionUser);
  }

  it("rejects a moveStatus rule when the author lacks task_update (H3c)", async () => {
    const caller = createAutomationManagerWith([
      { permission: "automation_manage", allowed: true },
      { permission: "task_update", allowed: false },
    ]);

    await expect(
      caller.create({
        projectId: PROJECT_A,
        name: "Move overdue",
        trigger: "dueDatePassed",
        action: "moveStatus",
        actionPayload: { statusId: STATUS_A },
      }),
    ).rejects.toThrow();

    expect(actor.prisma.automationRule.create).not.toHaveBeenCalled();
  });

  it("rejects an addComment rule when the author lacks task_comment (H3c)", async () => {
    const caller = createAutomationManagerWith([
      { permission: "automation_manage", allowed: true },
      { permission: "task_comment", allowed: false },
    ]);

    await expect(
      caller.create({
        projectId: PROJECT_A,
        name: "Comment on overdue",
        trigger: "dueDatePassed",
        action: "addComment",
        actionPayload: { content: "overdue" },
      }),
    ).rejects.toThrow();
    expect(actor.prisma.automationRule.create).not.toHaveBeenCalled();
  });

  it("rejects an archiveTask rule when the author lacks task_archive (H3c)", async () => {
    const caller = createAutomationManagerWith([
      { permission: "automation_manage", allowed: true },
      { permission: "task_archive", allowed: false },
    ]);

    await expect(
      caller.create({
        projectId: PROJECT_A,
        name: "Archive stale",
        trigger: "dueDatePassed",
        action: "archiveTask",
        actionPayload: {},
      }),
    ).rejects.toThrow();
    expect(actor.prisma.automationRule.create).not.toHaveBeenCalled();
  });

  it("creates the rule with the author as creator when every permission is present (H3a)", async () => {
    const caller = createAutomationManagerWith([
      { permission: "automation_manage", allowed: true },
      { permission: "task_update", allowed: true },
    ]);

    await caller.create({
      projectId: PROJECT_A,
      name: "Move overdue",
      trigger: "dueDatePassed",
      action: "moveStatus",
      actionPayload: { statusId: STATUS_A },
    });

    expect(actor.prisma.automationRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdByUserId: actor.userId }),
      }),
    );
  });

  it("rejects a rule whose actionPayload statusId belongs to another project (H3d)", async () => {
    const caller = createAutomationManagerWith([
      { permission: "automation_manage", allowed: true },
      { permission: "task_update", allowed: true },
    ]);

    await expect(
      caller.create({
        projectId: PROJECT_A,
        name: "Cross-project move",
        trigger: "dueDatePassed",
        action: "moveStatus",
        actionPayload: { statusId: STATUS_B },
      }),
    ).rejects.toThrow(/statusId does not belong to the rule's project/);
    expect(actor.prisma.automationRule.create).not.toHaveBeenCalled();
  });

  it("rejects a rule whose actionPayload taskId is another project's task (H3d)", async () => {
    const caller = createAutomationManagerWith([
      { permission: "automation_manage", allowed: true },
      { permission: "task_comment", allowed: true },
    ]);

    await expect(
      caller.create({
        projectId: PROJECT_A,
        name: "Cross-project comment",
        trigger: "statusChanged",
        action: "addComment",
        actionPayload: { taskId: TASK_B, content: "hi" },
      }),
    ).rejects.toThrow(/target task is not in the rule's project/);
    expect(actor.prisma.automationRule.create).not.toHaveBeenCalled();
  });

  it("rejects a rule whose actionPayload assigneeId is not a project member (H3d)", async () => {
    const caller = createAutomationManagerWith([
      { permission: "automation_manage", allowed: true },
      { permission: "task_update", allowed: true },
    ]);

    await expect(
      caller.create({
        projectId: PROJECT_A,
        name: "Assign outsider",
        trigger: "dueDatePassed",
        action: "assignTask",
        actionPayload: { assigneeId: "cmab8yxxp000ai7p4k8n2v3qd" },
      }),
    ).rejects.toThrow(/assigneeId is not a project member/);
    expect(actor.prisma.automationRule.create).not.toHaveBeenCalled();
  });

  it("rejects a rule whose triggerCondition statusId belongs to another project (H3d)", async () => {
    const caller = createAutomationManagerWith([
      { permission: "automation_manage", allowed: true },
      { permission: "task_update", allowed: true },
    ]);

    await expect(
      caller.create({
        projectId: PROJECT_A,
        name: "Cross-project condition",
        trigger: "statusChanged",
        action: "assignTask",
        actionPayload: { assigneeId: ASSIGNee_A },
        triggerCondition: { fromStatusId: STATUS_B },
      }),
    ).rejects.toThrow(/fromStatusId does not belong to the rule's project/);
    expect(actor.prisma.automationRule.create).not.toHaveBeenCalled();
  });

  it("update re-checks the action permission for the resulting action (H3c)", async () => {
    const caller = createAutomationManagerWith([
      { permission: "automation_manage", allowed: true },
      // task_comment denied: the update retargets the rule at addComment.
      { permission: "task_comment", allowed: false },
    ]);

    await expect(
      caller.update({
        id: RULE_ID,
        action: "addComment",
        actionPayload: { content: "now a comment rule" },
      }),
    ).rejects.toThrow();
    expect(actor.prisma.automationRule.update).not.toHaveBeenCalled();
  });
});
