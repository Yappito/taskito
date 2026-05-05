"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { ListView } from "@/components/task/list-view";
import { BoardView } from "@/components/task/board-view";
import { TimelineGraph } from "@/components/graph/timeline-graph";
import { ArchivedTasks } from "@/components/task/archived-tasks";
import { TaskDetail } from "@/components/task/task-detail";
import { QuickAdd } from "@/components/task/quick-add";
import { ProjectSwitcher } from "@/components/ui/project-switcher";
import { AiChatLauncher } from "@/components/ai/ai-chat-launcher";
import { cn } from "@/lib/utils";

/** Project page with list, board, and graph view tabs */
export default function ProjectPage({
  params,
}: {
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = use(params);
  return <ProjectPageContent projectSlug={projectSlug} />;
}

function ProjectPageContent({ projectSlug }: { projectSlug: string }) {
  const [view, setView] = useState<"list" | "board" | "graph" | "archive">("board");
  const [selectedSearchTaskId, setSelectedSearchTaskId] = useState<string | null>(null);
  const [isRecoveringProject, setIsRecoveringProject] = useState(false);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Open task from URL query param (?task=<id>)
  useEffect(() => {
    const taskId = searchParams.get("task");
    if (taskId) {
      setSelectedSearchTaskId(taskId);
      // Clean URL
      router.replace(`/${projectSlug}`, { scroll: false });
    }
  }, [searchParams, projectSlug, router]);

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
  const viewDescriptions: Record<typeof view, string> = {
    list: "Scan, sort, and bulk edit tasks.",
    board: "Move work through delivery stages.",
    graph: "Inspect schedule and dependency risk.",
    archive: "Review completed and archived work.",
  };

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
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <ProjectSwitcher
                currentProjectSlug={project.slug}
                projects={(projects ?? []).map((item) => ({
                  id: item.id,
                  name: item.name,
                  slug: item.slug,
                  key: item.key,
                }))}
                disabled={projectsLoading || !projects?.length}
              />
              <span
                className="rounded-full px-2.5 py-1 text-xs font-semibold"
                style={{ backgroundColor: "var(--color-accent-muted)", color: "var(--color-accent)" }}
              >
                {project.key}
              </span>
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                /{project.slug}
              </span>
            </div>
            <h1 className="mt-3 truncate text-3xl font-semibold tracking-tight" style={{ color: "var(--color-text)" }}>
              {project.name}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
              {project.description || viewDescriptions[view]}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {statuses.slice(0, 6).map((status) => (
                <span
                  key={status.id}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                  style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text-secondary)" }}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: status.color }} />
                  {status.name}
                </span>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3 md:flex-row md:items-center xl:justify-end">
            <div
              className="grid grid-cols-4 rounded-2xl p-1"
              style={{ backgroundColor: "var(--color-bg-muted)", border: "1px solid var(--color-border)" }}
            >
              {(["list", "board", "graph", "archive"] as const).map((v) => (
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
                  {v}
                </button>
              ))}
            </div>
            <QuickAdd
              projectId={project.id}
              statuses={statuses}
              tags={tags ?? []}
            />
            <AiChatLauncher
              projectId={project.id}
              title={`AI workspace for ${project.name}`}
              buttonLabel="Project AI"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={`/${projectSlug}/settings/workflow`}
            className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)", backgroundColor: "var(--color-surface)" }}
          >
            Workflow
          </Link>
          <Link
            href={`/${projectSlug}/settings/tags`}
            className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)", backgroundColor: "var(--color-surface)" }}
          >
            Tags
          </Link>
          <Link
            href={`/${projectSlug}/settings/custom-fields`}
            className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)", backgroundColor: "var(--color-surface)" }}
          >
            Custom Fields
          </Link>
          <Link
            href={`/${projectSlug}/settings/ai`}
            className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)", backgroundColor: "var(--color-surface)" }}
          >
            AI
          </Link>
        </div>
      </div>

      {/* View content */}
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
