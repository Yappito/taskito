import { PrismaClient, StatusCategory, TaskPriority, LinkType } from "@prisma/client";
import { hashPassword } from "./password-support";

const prisma = new PrismaClient();
const allowDemoSeed = process.env.NODE_ENV !== "production" || process.env.ALLOW_DEMO_SEED === "true";
const demoAdminPassword = process.env.DEMO_ADMIN_PASSWORD?.trim() || "taskito-demo-2026";

/**
 * Seed script: creates 1 user, 1 project, default workflow,
 * 50 sample tasks with 30 links, and sample tags.
 */
async function main() {
  console.log("🌱 Seeding database...");

  if (!allowDemoSeed) {
    throw new Error("Refusing to seed demo data in production without ALLOW_DEMO_SEED=true");
  }

  // ─── User ──────────────────
  const passwordHash = await hashPassword(demoAdminPassword);
  const legacyAdmin = await prisma.user.findUnique({
    where: { email: "admin@taskgraph.local" },
  });

  if (legacyAdmin) {
    await prisma.user.update({
      where: { id: legacyAdmin.id },
      data: { email: "admin@taskito.local", password: passwordHash },
    });
  }

  const user = await prisma.user.upsert({
    where: { email: "admin@taskito.local" },
    update: { password: passwordHash, role: "admin" },
    create: {
      email: "admin@taskito.local",
      name: "Admin",
      password: passwordHash,
      role: "admin",
    },
  });
  console.log(`  ✅ User: ${user.email}`);
  console.log(`  🔐 Demo admin password: ${demoAdminPassword}`);

  // ─── Project ───────────────
  const project = await prisma.project.upsert({
    where: { slug: "default" },
    update: {},
    create: {
      name: "Default Project",
      slug: "default",
      key: "DEF",
      description: "The default Taskito project with sample data",
    },
  });
  console.log(`  ✅ Project: ${project.name}`);

  await prisma.projectMember.upsert({
    where: {
      projectId_userId: {
        projectId: project.id,
        userId: user.id,
      },
    },
    update: { role: "owner" },
    create: {
      projectId: project.id,
      userId: user.id,
      role: "owner",
    },
  });

  // ─── Workflow Statuses ─────
  const statusDefs = [
    { name: "Backlog", color: "#6b7280", order: 0, category: StatusCategory.backlog, isFinal: false },
    { name: "To Do", color: "#3b82f6", order: 1, category: StatusCategory.todo, isFinal: false },
    { name: "In Progress", color: "#f59e0b", order: 2, category: StatusCategory.active, isFinal: false },
    { name: "In Review", color: "#8b5cf6", order: 3, category: StatusCategory.active, isFinal: false },
    { name: "Done", color: "#10b981", order: 4, category: StatusCategory.done, isFinal: true },
    { name: "Cancelled", color: "#ef4444", order: 5, category: StatusCategory.cancelled, isFinal: false },
  ];

  const statuses = await Promise.all(
    statusDefs.map((s) =>
      prisma.workflowStatus.upsert({
        where: { projectId_name: { projectId: project.id, name: s.name } },
        update: {},
        create: { ...s, projectId: project.id },
      })
    )
  );
  console.log(`  ✅ Statuses: ${statuses.length}`);

  // Set default status
  await prisma.project.update({
    where: { id: project.id },
    data: { settings: { defaultStatusId: statuses[0].id } },
  });

  // ─── Transitions ───────────
  // Linear flow + skip-to-cancelled
  for (let i = 0; i < statuses.length - 2; i++) {
    await prisma.workflowTransition.upsert({
      where: {
        projectId_fromStatusId_toStatusId: {
          projectId: project.id,
          fromStatusId: statuses[i].id,
          toStatusId: statuses[i + 1].id,
        },
      },
      update: {},
      create: {
        projectId: project.id,
        fromStatusId: statuses[i].id,
        toStatusId: statuses[i + 1].id,
      },
    });
    // Allow moving to Cancelled from any non-terminal
    await prisma.workflowTransition.upsert({
      where: {
        projectId_fromStatusId_toStatusId: {
          projectId: project.id,
          fromStatusId: statuses[i].id,
          toStatusId: statuses[5].id,
        },
      },
      update: {},
      create: {
        projectId: project.id,
        fromStatusId: statuses[i].id,
        toStatusId: statuses[5].id,
      },
    });
  }
  console.log(`  ✅ Transitions created`);

  // ─── Tags ──────────────────
  const tagDefs = [
    { name: "frontend", color: "#3b82f6" },
    { name: "backend", color: "#10b981" },
    { name: "devops", color: "#f59e0b" },
    { name: "design", color: "#ec4899" },
    { name: "bug", color: "#ef4444" },
    { name: "feature", color: "#8b5cf6" },
    { name: "documentation", color: "#6b7280" },
    { name: "performance", color: "#f97316" },
  ];

  const tags = await Promise.all(
    tagDefs.map((t) =>
      prisma.tag.upsert({
        where: { projectId_name: { projectId: project.id, name: t.name } },
        update: {},
        create: { ...t, projectId: project.id },
      })
    )
  );
  console.log(`  ✅ Tags: ${tags.length}`);

  // ─── Tasks (50 sample tasks) ──
  const taskTitles = [
    "Set up project repository",
    "Design database schema",
    "Implement user authentication",
    "Create API endpoints",
    "Build login page",
    "Set up CI/CD pipeline",
    "Write unit tests for auth",
    "Design graph view mockup",
    "Implement task CRUD operations",
    "Add drag-and-drop to board",
    "Create quick-add component",
    "Build timeline axis with D3",
    "Implement ELK layout engine",
    "Render task nodes as SVG",
    "Add dependency edge rendering",
    "Implement viewport culling",
    "Build minimap component",
    "Create workflow status editor",
    "Add transition validation",
    "Implement auto-tagging service",
    "Improve global task search",
    "Build search UI with Cmd+K",
    "Add faceted filter sidebar",
    "Optimize mobile responsive layout",
    "Create PWA manifest",
    "Write E2E tests with Playwright",
    "Build Docker production image",
    "Add health check endpoints",
    "Create backup script",
    "Document API endpoints",
    "Implement rich text editor",
    "Add comment system",
    "Build tag management page",
    "Create custom field support",
    "Add keyboard shortcuts",
    "Implement optimistic updates",
    "Build notification system",
    "Add date range picker",
    "Create task import/export",
    "Design color theme system",
    "Implement batch task operations",
    "Add Gantt-style zoom levels",
    "Build project settings page",
    "Create onboarding flow",
    "Implement undo/redo for graph",
    "Add touch gesture support",
    "Build offline mutation queue",
    "Create performance dashboard",
    "Implement webhook listeners",
    "Final QA and polish",
  ];

  const now = new Date();
  const tasks = [];

  for (let i = 0; i < 50; i++) {
    const daysOffset = Math.floor(i / 3) - 5;
    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + daysOffset);

    const startDate = new Date(dueDate);
    startDate.setDate(startDate.getDate() - Math.floor(Math.random() * 5) - 1);

    const statusIdx = i < 10 ? 4 : i < 20 ? 3 : i < 30 ? 2 : i < 40 ? 1 : 0;
    const priorityArr: TaskPriority[] = ["none", "low", "medium", "high", "urgent"];
    const priority = priorityArr[i % 5];

    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        taskNumber: i + 1,
        title: taskTitles[i],
        statusId: statuses[statusIdx].id,
        closedAt: statusDefs[statusIdx].isFinal ? dueDate : null,
        priority,
        dueDate,
        startDate,
      },
    });
    tasks.push(task);

    // Assign 1-2 random tags
    const tagCount = (i % 3) + 1;
    const tagIndices = new Set<number>();
    for (let j = 0; j < tagCount; j++) {
      tagIndices.add((i + j * 3) % tags.length);
    }
    await prisma.taskTag.createMany({
      data: [...tagIndices].map((idx) => ({
        taskId: task.id,
        tagId: tags[idx].id,
      })),
      skipDuplicates: true,
    });
  }
  console.log(`  ✅ Tasks: ${tasks.length}`);

  // ─── Task Links (30 dependencies) ──
  const linkTypes: LinkType[] = ["blocks", "relates", "parent", "child"];
  let linkCount = 0;

  for (let i = 0; i < 30; i++) {
    const sourceIdx = i;
    const targetIdx = Math.min(sourceIdx + 1 + (i % 3), 49);

    if (sourceIdx === targetIdx) continue;

    try {
      await prisma.taskLink.create({
        data: {
          sourceTaskId: tasks[sourceIdx].id,
          targetTaskId: tasks[targetIdx].id,
          linkType: linkTypes[i % linkTypes.length],
        },
      });
      linkCount++;
    } catch {
      // Skip if duplicate
    }
  }
  console.log(`  ✅ Links: ${linkCount}`);

  console.log("🌱 Seeding complete!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
