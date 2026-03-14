"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { TaskCard } from "./task-card";
import { TaskDetail } from "./task-detail";
import { Button } from "@/components/ui/button";

interface ArchivedTasksProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string }>;
}

/** View for archived tasks with the ability to unarchive */
export function ArchivedTasks({ projectId, statuses }: ArchivedTasksProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.task.list.useQuery({
    projectId,
    archivedOnly: true,
    limit: 100,
  });

  const unarchiveTask = trpc.task.unarchive.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
    },
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-3">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-lg"
              style={{ backgroundColor: "var(--color-bg-muted)" }}
            />
          ))}
        </div>
      </div>
    );
  }

  const tasks = data?.items ?? [];

  if (tasks.length === 0) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <div className="text-center">
          <p
            className="text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            No archived tasks
          </p>
          <p
            className="mt-1 text-xs"
            style={{ color: "var(--color-text-muted)" }}
          >
            Tasks in statuses with auto-archive enabled will appear here
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex">
      <div className="flex-1 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Archived Tasks ({tasks.length})
          </h2>
        </div>
        <div className="space-y-2">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center gap-2"
            >
              <div className="flex-1">
                <TaskCard
                  task={task}
                  onClick={() => setSelectedTaskId(task.id)}
                  className="opacity-70"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => unarchiveTask.mutate({ id: task.id })}
                disabled={unarchiveTask.isPending}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      </div>

      {selectedTaskId && (
        <TaskDetail
          taskId={selectedTaskId}
          statuses={statuses}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </div>
  );
}
