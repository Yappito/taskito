"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { DialogControlled as Dialog, DialogContent } from "@/components/ui/dialog";

import { AiChatPanel } from "./ai-chat-panel";

interface AiChatLauncherProps {
  projectId: string;
  taskId?: string;
  selectedTaskIds?: string[];
  title: string;
  buttonLabel?: string;
  buttonIcon?: ReactNode;
  buttonVariant?: ButtonProps["variant"];
  buttonClassName?: string;
  buttonStyle?: CSSProperties;
}

export function AiChatLauncher({
  projectId,
  taskId,
  selectedTaskIds = [],
  title,
  buttonLabel = "Ask AI",
  buttonIcon,
  buttonVariant = "outline",
  buttonClassName,
  buttonStyle,
}: AiChatLauncherProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant={buttonVariant}
        size="sm"
        onClick={() => setOpen(true)}
        className={buttonClassName}
        style={buttonStyle}
      >
        {buttonIcon}
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
