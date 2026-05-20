"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Bot } from "lucide-react";
import { trpc } from "@/lib/trpc-client";
import { ListView } from "@/components/task/list-view";
import { BoardView } from "@/components/task/board-view";
import { TimelineGraph } from "@/components/graph/timeline-graph";
import { ArchivedTasks } from "@/components/task/archived-tasks";
import { CalendarView } from "@/components/calendar/calendar-view";
import { GanttView } from "@/components/gantt/gantt-view";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { SprintView } from "@/components/sprint/sprint-view";
import { TaskDetail } from "@/components/task/task-detail";
import { QuickAdd } from "@/components/task/quick-add";
import { AiChatLauncher } from "@/components/ai/ai-chat-launcher";
import { cn } from "@/lib/utils";

/** Project page with list, board, and graph view tabs */
type ProjectView = "dashboard" | "list" | "board" | "calendar" | "gantt" | "sprint" | "graph" | "archive";
const projectViews: ProjectView[] = ["dashboard", "list", "board", "calendar", "gantt", "sprint", "graph", "archive"];
const LAST_PROJECT_VIEW_KEY = "taskito-last-project-view";

function getProjectViewStorageKey(projectSlug: string) {
  return `${LAST_PROJECT_VIEW_KEY}:${projectSlug}`;
}

export default function ProjectPage({
  params,
}: {
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = use(params);
  return <ProjectPageContent projectSlug={projectSlug} />;
}

function ProjectPageContent({ projectSlug }: { projectSlug: string }) {
  const [view, setView] = useState<ProjectView>(() => {
    if (typeof window === "undefined") {
      return "dashboard";
    }

    const storedView = window.localStorage.getItem(getProjectViewStorageKey(projectSlug))
      ?? window.localStorage.getItem(LAST_PROJECT_VIEW_KEY);
    return storedView && projectViews.includes(storedView as ProjectView)
      ? storedView as ProjectView
      : "dashboard";
  });
  const [selectedSearchTaskId, setSelectedSearchTaskId] = useState<string | null>(null);
  const [isRecoveringProject, setIsRecoveringProject] = useState(false);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Open task from URL query param (?task=<id>)
  useEffect(() => {
    const requestedView = searchParams.get("view");
    if (requestedView && projectViews.includes(requestedView as ProjectView)) {
      setView(requestedView as ProjectView);
    } else if (typeof window !== "undefined") {
      const storedView = window.localStorage.getItem(getProjectViewStorageKey(projectSlug))
        ?? window.localStorage.getItem(LAST_PROJECT_VIEW_KEY);
      if (storedView && projectViews.includes(storedView as ProjectView)) {
        setView(storedView as ProjectView);
      }
    }

    const taskId = searchParams.get("task");
    if (taskId) {
      setSelectedSearchTaskId(taskId);
      // Clean URL
      router.replace(`/${projectSlug}`, { scroll: false });
    }
  }, [searchParams, projectSlug, router]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(LAST_PROJECT_VIEW_KEY, view);
    window.localStorage.setItem(getProjectViewStorageKey(projectSlug), view);
  }, [projectSlug, view]);

  const { data: project, isLoading } = trpc.project.bySlug.useQuery({
    slug: projectSlug,
  });

  const { data: projects, isLoading: projectsLoading } = trpc.project.list.useQuery();

  useEffect(() => {
    if (isLoading || projectsLoading || project) {
      setIsRecoveringProject(false);
      return;
    }

    const fallbackProject = (projects ?? []).find((candidate) => candidate.slug !== projectSlug);
    if (!fallbackProject) {
      setIsRecoveringProject(false);
      return;
    }

    setIsRecoveringProject(true);
    router.replace(`/${fallbackProject.slug}`);
  }, [isLoading, project, projectSlug, projects, projectsLoading, router]);

  const { data: tags } = trpc.tag.list.useQuery(
    { projectId: project?.id ?? "" },
    { enabled: !!project?.id }
  );

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="animate-pulse" style={{ color: "var(--color-text-muted)" }}>Loading project...</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <p style={{ color: "var(--color-text-muted)" }}>
          {isRecoveringProject ? "Redirecting to an available project..." : "Project not found"}
        </p>
      </div>
    );
  }

  const statuses = project.statuses ?? [];
  const projectSettings = (project as { settings?: Record<string, unknown> | null }).settings ?? null;
  const projectSettingsLinks = [
    { href: `/${projectSlug}/settings/workflow`, label: "Workflow" },
    { href: `/${projectSlug}/settings/tags`, label: "Tags" },
    { href: `/${projectSlug}/settings/custom-fields`, label: "Custom Fields" },
    { href: `/${projectSlug}/settings/ai`, label: "AI" },
    { href: `/${projectSlug}/settings/automation`, label: "Automation" },
  ];

  return (
    <div className="min-h-[calc(100vh-4rem)]">
      <div
        className="border-b px-4 py-4 lg:px-6"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-elevated)) 0%, var(--color-bg-elevated) 44%, var(--color-bg) 100%)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div
            className="flex w-fit flex-wrap rounded-2xl p-1"
            style={{ backgroundColor: "var(--color-bg-muted)", border: "1px solid var(--color-border)" }}
          >
              {projectViews.map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={cn(
                    "rounded-xl px-3 py-2 text-sm capitalize transition-colors",
                    view === v ? "font-semibold" : ""
                  )}
                  style={
                    view === v
                      ? {
                          backgroundColor: "var(--color-surface)",
                          color: "var(--color-text)",
                          boxShadow: "var(--shadow-sm)",
                        }
                      : { color: "var(--color-text-secondary)" }
                  }
                  >
                  {v === "gantt" ? "Gantt" : v}
                </button>
              ))}
          </div>
          <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
            <QuickAdd
              projectId={project.id}
              statuses={statuses}
              tags={tags ?? []}
            />
            <AiChatLauncher
              projectId={project.id}
              title={`AI workspace for ${project.name}`}
              buttonLabel="Project AI"
              buttonIcon={<Bot />}
              buttonVariant="default"
              buttonClassName="border-0 text-white hover:opacity-90"
              buttonStyle={{
                background: "linear-gradient(135deg, #22d3ee 0%, #8b5cf6 48%, #f472b6 100%)",
                boxShadow: "0 0 0 1px rgba(255,255,255,0.1) inset, 0 0 22px rgba(34,211,238,0.35), 0 0 34px rgba(244,114,182,0.22)",
              }}
            />
            {projectSettingsLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{
                  borderColor: "var(--color-border)",
                  color: "var(--color-text-secondary)",
                  backgroundColor: "var(--color-surface)",
                }}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* View content */}
      {view === "dashboard" && (
        <DashboardView
          projectId={project.id}
          statuses={statuses}
          tags={tags ?? []}
          projectSettings={projectSettings}
        />
      )}
      {view === "list" && (
        <ListView
          projectId={project.id}
          statuses={statuses}
          tags={tags ?? []}
          projectSettings={projectSettings}
        />
      )}
      {view === "board" && (
        <BoardView
          projectId={project.id}
          statuses={statuses}
          tags={tags ?? []}
          projectSettings={projectSettings}
        />
      )}
      {view === "calendar" && (
        <CalendarView
          projectId={project.id}
          statuses={statuses}
          tags={tags ?? []}
          projectSettings={projectSettings}
        />
      )}
      {view === "gantt" && (
        <GanttView
          projectId={project.id}
          statuses={statuses}
          tags={tags ?? []}
          projectSettings={projectSettings}
        />
      )}
      {view === "sprint" && (
        <SprintView
          projectId={project.id}
          statuses={statuses}
          tags={tags ?? []}
          projectSettings={projectSettings}
        />
      )}
      {view === "graph" && (
        <TimelineGraph
          projectId={project.id}
          statuses={statuses}
          tags={tags ?? []}
          projectSettings={projectSettings}
        />
      )}
      {view === "archive" && (
        <ArchivedTasks projectId={project.id} statuses={statuses} tags={tags ?? []} />
      )}

      {/* Task detail from search navigation */}
      {selectedSearchTaskId && (
        <TaskDetail
          taskId={selectedSearchTaskId}
          statuses={statuses}
          onClose={() => setSelectedSearchTaskId(null)}
        />
      )}
    </div>
  );
}
