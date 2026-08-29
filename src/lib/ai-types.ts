export const AI_PERMISSION_VALUES = [
  "read_current_task",
  "read_selected_tasks",
  "search_project",
  "add_comment",
  "link_tasks",
  "move_status",
  "assign_task",
  "edit_core_fields",
  "edit_tags",
  "edit_custom_fields",
  "bulk_update_selected",
  "create_task",
  "duplicate_task",
  "archive_task",
] as const;

export type AiPermission = (typeof AI_PERMISSION_VALUES)[number];

export const AI_PERMISSION_PRESETS = {
  read_only: ["read_current_task", "read_selected_tasks", "search_project"],
  triage: [
    "read_current_task",
    "read_selected_tasks",
    "search_project",
    "add_comment",
    "link_tasks",
    "move_status",
    "assign_task",
  ],
  editor: [
    "read_current_task",
    "read_selected_tasks",
    "search_project",
    "add_comment",
    "link_tasks",
    "move_status",
    "assign_task",
    "edit_core_fields",
    "edit_tags",
    "edit_custom_fields",
    "create_task",
    "duplicate_task",
    "archive_task",
  ],
  bulk_editor: [
    "read_current_task",
    "read_selected_tasks",
    "search_project",
    "add_comment",
    "link_tasks",
    "move_status",
    "assign_task",
    "edit_core_fields",
    "edit_tags",
    "edit_custom_fields",
    "bulk_update_selected",
    "create_task",
    "duplicate_task",
    "archive_task",
  ],
} as const satisfies Record<string, readonly AiPermission[]>;

export type AiPermissionPreset = keyof typeof AI_PERMISSION_PRESETS;

export interface AiToolProposal<TPayload = Record<string, unknown>> {
  actionType:
    | "addComment"
    | "addLink"
    | "removeLink"
    | "moveStatus"
    | "assignTask"
    | "editTask"
    | "bulkUpdate"
    | "createTask"
    | "duplicateTask"
    | "archiveTask"
    | "unarchiveTask";
  projectId: string;
  taskId?: string;
  title: string;
  summary: string;
  payload: TPayload;
  /** Native provider tool-call id this proposal originated from (absent for markdown fallback). */
  toolCallId?: string;
}

/**
 * Proposal-level normalization failure kept out of the proposal list. Native
 * tool-call drops carry their `toolCallId` so the orchestrator can answer the
 * model with a paired role:"tool" result (see {@link AiToolMessage}).
 */
export interface AiProposalDrop {
  toolCallId?: string;
  name?: string;
  reason: string;
}

/** Result of normalizing raw model output into Taskito proposals. */
export interface AiProposalNormalizationResult {
  proposals: Array<AiToolProposal>;
  drops: Array<AiProposalDrop>;
}

/**
 * Provider-neutral tool-result message used by the AI tool-result loop.
 *
 * This row is persisted on `AiMessage` as `role: "tool"` with columns
 * `toolCallId`, `toolName`, and content = compact JSON outcome. When a
 * conversation is replayed to a provider, each assistant message whose
 * `toolCalls` JSON contains a call id must be followed by its `role: "tool"`
 * rows. Adapter mapping contract (adapter bead):
 * - Anthropic: the replayed assistant turn must emit a `tool_use` content block
 *   `{ type: "tool_use", id: toolCallId, name, input }` built from the stored
 *   `toolCalls` JSON; this tool message maps to a user turn carrying a
 *   `tool_result` block `{ type: "tool_result", tool_use_id: toolCallId, content }`.
 *   `name` is not sent on the tool_result itself (Anthropic matches by id).
 * - OpenAI-compatible: the replayed assistant turn emits
 *   `tool_calls: [{ id: toolCallId, type: "function", function: { name, arguments } }]`
 *   and this message maps to `{ role: "tool", tool_call_id: toolCallId, content }`.
 *   `name` is not sent on the tool message itself (OpenAI matches by id).
 */
export interface AiToolMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

export interface AiProviderConnectionFormValues {
  label: string;
  adapter: "openai_compatible" | "anthropic";
  baseUrl: string;
  model: string;
  secret: string;
  defaultHeaders?: Record<string, string>;
  isEnabled?: boolean;
  isDefault?: boolean;
}

export interface AiConversationContextInput {
  projectId: string;
  taskId?: string | null;
  selectedTaskIds?: string[];
}

export interface AiConversationContextSnapshot {
  project: {
    id: string;
    name: string;
    key: string;
    slug: string;
  };
  currentTask?: Record<string, unknown> | null;
  projectTasks: Array<Record<string, unknown>>;
  selectedTasks: Array<Record<string, unknown>>;
  statuses: Array<Record<string, unknown>>;
  tags: Array<Record<string, unknown>>;
  people: Array<Record<string, unknown>>;
  customFields: Array<Record<string, unknown>>;
  /** True when the char budget forced rows out of the snapshot. */
  truncated?: boolean;
}
