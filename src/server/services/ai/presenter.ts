import type { AiConversationContextSnapshot } from "@/lib/ai-types";

export function buildAiSystemPrompt(input: {
  projectName: string;
  mode: "approval" | "yolo";
  permissions: string[];
  currentDate: string;
}) {
  return [
    `You are Taskito AI operating inside project ${input.projectName}.`,
    `Conversation mode: ${input.mode}.`,
    `Current date and time: ${input.currentDate}.`,
    `Allowed permissions: ${input.permissions.join(", ") || "none"}.`,
    "Never claim to have executed a write unless a proposal was approved or auto-executed in yolo mode.",
    "When suggesting writes, return a fenced json block labeled proposal containing an array of proposal objects.",
    "Available write actionTypes include addComment, addLink, removeLink, moveStatus, assignTask, editTask, bulkUpdate, createTask, duplicateTask, archiveTask, and unarchiveTask when the matching permission is granted.",
    "For createTask proposals, payload.title and payload.dueDate are required. dueDate must be an ISO-compatible date string because Taskito tasks require a due date.",
    "Do not infer due dates from unrelated older tasks. When proposing a new task, choose a due date on or after the current date unless the user explicitly asks for a past date.",
    "For bulkUpdate proposals, payload.taskIds must contain only the selected task ids provided in the context.",
    "Valid Taskito link types are exactly: blocks, relates, parent, and child.",
    "To express implementation order or 'A depends on B', use addLink with sourceTaskId set to B, targetTaskId set to A, and linkType set to blocks. Do not use depends_on as a final linkType value.",
    "For addLink and removeLink proposals, payload.sourceTaskId and payload.targetTaskId may be task ids or task keys like PROJECT-123 from the context.",
    "For removeLink proposals, use payload.linkId when a link id is present in context.currentTask.links, or identify the link with sourceTaskId, targetTaskId, and linkType.",
    "Use context.projectTasks for the loaded project task list. It is capped, so say it is a bounded project task sample rather than claiming the project has no tasks.",
    'Example: ```proposal\n[{"actionType":"moveStatus","title":"Move TASK-1 to Done","summary":"...","payload":{...}}]\n```',
    "Outside the proposal block, provide concise assistant text.",
  ].join("\n");
}

function extractProposalBlock(content: string) {
  const patterns = [/```proposal\s*([\s\S]*?)```/i, /```json\s*([\s\S]*?)```/i];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match;
    }
  }

  return null;
}

export function buildAiContextMessage(snapshot: AiConversationContextSnapshot) {
  return JSON.stringify(snapshot, null, 2);
}

export function extractAiProposals(content: string) {
  const match = extractProposalBlock(content);
  if (!match) {
    return [] as unknown[];
  }

  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [] as unknown[];
  }
}

export function stripAiProposalBlock(content: string) {
  const match = extractProposalBlock(content);
  if (!match) {
    return content.trim();
  }

  return content.replace(match[0], "").trim();
}

export function normalizeAiConversationTitle(content: string) {
  const normalized = content
    .replace(/^['"`\s]+|['"`\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return normalized.replace(/[.?!,:;]+$/g, "").trim().slice(0, 120).trim();
}
