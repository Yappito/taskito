"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DialogControlled as Dialog, DialogContent } from "@/components/ui/dialog";

import { AiChatPanel } from "./ai-chat-panel";

interface AiChatLauncherProps {
  projectId: string;
  taskId?: string;
  selectedTaskIds?: string[];
  title: string;
  buttonLabel?: string;
}

export function AiChatLauncher({ projectId, taskId, selectedTaskIds = [], title, buttonLabel = "Ask AI" }: AiChatLauncherProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {buttonLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} panelClassName="h-[95vh] max-w-[min(96vw,1800px)] overflow-hidden p-0">
        <DialogContent className="h-full w-full">
          <AiChatPanel
            projectId={projectId}
            taskId={taskId}
            selectedTaskIds={selectedTaskIds}
            title={title}
            onClose={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
