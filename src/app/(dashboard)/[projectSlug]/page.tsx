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

  return (
    <div>
      {/* Toolbar */}
      <div
        className="flex items-center justify-between border-b px-4 py-2"
        style={{
          backgroundColor: "var(--color-bg-elevated)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="flex items-center gap-2">
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
          <div
            className="ml-4 flex rounded-lg p-0.5"
            style={{ backgroundColor: "var(--color-bg-muted)" }}
          >
            {(["list", "board", "graph", "archive"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm capitalize transition-colors",
                  view === v ? "font-medium" : ""
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
        </div>
        <div className="flex items-center gap-2">
          <QuickAdd
            projectId={project.id}
            statuses={statuses}
            tags={tags ?? []}
          />
          <Link
            href={`/${projectSlug}/settings/workflow`}
            className="rounded px-2 py-1 text-xs transition-colors"
            style={{ color: "var(--color-text-muted)" }}
          >
            Workflow
          </Link>
          <Link
            href={`/${projectSlug}/settings/tags`}
            className="rounded px-2 py-1 text-xs transition-colors"
            style={{ color: "var(--color-text-muted)" }}
          >
            Tags
          </Link>
          <Link
            href={`/${projectSlug}/settings/custom-fields`}
            className="rounded px-2 py-1 text-xs transition-colors"
            style={{ color: "var(--color-text-muted)" }}
          >
            Custom Fields
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
        <ArchivedTasks projectId={project.id} statuses={statuses} />
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
