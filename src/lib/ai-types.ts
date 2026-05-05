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
}
