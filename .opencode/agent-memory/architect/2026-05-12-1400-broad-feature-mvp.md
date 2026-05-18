---
agent: architect
created: 2026-05-12T14:00:00Z
scope: taskito-full-stack
type: implementation-plan
confidence: high
---

# Broad MVP Feature Implementation Plan

## Summary
Comprehensive plan for 10+ feature gaps in Taskito, sequenced to minimize rework and respect existing architecture patterns (tRPC routers, Prisma models, Next.js App Router pages, component hierarchy).

## Evidence
- Schema: prisma/schema.prisma (568 lines, 18 models)
- AI system: src/server/services/ai/ (orchestrator, tools, checkpoints, providers)
- Routers: src/server/routers/ (9 routers mounted in _app.ts)
- UI: src/components/ (task/, ai/, graph/, ui/)
- Views: board, list, graph (timeline/DAG), archive — all in project page
- No streaming: providers return full string, orchestrator awaits completion
- No native tool calling: AI proposals extracted from fenced JSON blocks in text
- No sprint/cycle, time tracking, recurring task, automation, calendar, command palette, PWA, or analytics models

## Details

### Current Architecture Map

**Data layer**: PostgreSQL via Prisma, 18 models. Key relations: Project→Task→(Comment, TaskLink, CustomFieldValue, ActivityEvent, TaskWatcher, Notification). AI models: AiProviderConnection, AiProjectPolicy, AiConversation→AiMessage→AiActionExecution.

**API layer**: 9 tRPC routers (project, task, tag, workflow, customField, notification, search, user, ai). All use `protectedProcedure`. AI router has provider CRUD, conversation CRUD, send/approve/reject/rollback. No subscription/streaming endpoints.

**AI pipeline**: orchestrator.ts → provider (openai_compatible or anthropic) → presenter.ts (system prompt + proposal extraction from markdown fences) → tools.ts (normalize/resolve proposals) → action-executor.ts (calls task router via tRPC caller) → checkpoints.ts (snapshot before/after for rollback).

**UI layer**: Next.js 15 App Router. Dashboard layout wraps project pages. Project page has 4 view tabs (list, board, graph, archive). AI chat is a slide-in panel. Settings at /[slug]/settings/{workflow,tags,custom-fields,ai}. Search modal exists (Cmd+K pattern).

**Key constraints**:
- tRPC over HTTP only (no WS); no SSE/subscription support currently
- CSP header blocks most connect-src (only 'self')
- output: 'standalone' in next.config.ts
- No service worker or manifest (not PWA)
- Task.dueDate is required (non-nullable DateTime)

---

## Feature-by-Feature Design

### 1. AI Streaming (SSE via Next.js Route Handler)

**Why**: Current AI chat blocks 90s+ while provider responds. User sees only "Thinking..." dots. Unacceptable UX.

**Approach**: Add a Next.js Route Handler (`src/app/api/ai/stream/route.ts`) that calls the provider with `stream: true` and pipes SSE chunks. The tRPC `sendMessage` mutation returns immediately with a conversation ID + pending message ID. The client opens an EventSource to `/api/ai/stream?conversationId=...&messageId=...` and receives incremental `content` events + a final `proposals` event.

**Schema changes**: Add `isStreaming` Boolean default false to `AiMessage`. Add `streamToken` String? to `AiConversation` (for SSE auth — a one-time token generated when sendMessage starts, consumed by the stream endpoint).

**Server changes**:
- `src/app/api/ai/stream/route.ts`: New Route Handler. Validates session + streamToken. Calls provider with `stream: true`. For each chunk: appends to AiMessage.content via upsert. Sends SSE `data: {"type":"content","delta":"..."}`. On final chunk: runs proposal extraction (existing `extractAiProposals`), creates AiActionExecutions, sends SSE `data: {"type":"proposals","executions":[...]}` + `data: {"type":"done"}`.
- `src/server/services/ai/provider-openai-compatible.ts`: Add `completeWithOpenAiCompatibleProviderStream()` that passes `stream: true` and returns an async iterable of deltas.
- `src/server/services/ai/provider-anthropic.ts`: Add `completeWithAnthropicProviderStream()` using Anthropic's streaming API.
- `src/server/services/ai/orchestrator.ts`: Refactor `appendAiAssistantTurn` into `startAiAssistantTurn` (creates message with `isStreaming: true`) + `finalizeAiAssistantTurn` (extracts proposals, creates executions, sets `isStreaming: false`).
- `src/server/routers/ai.ts`: `sendMessage` creates streamToken, calls `startAiAssistantTurn`, returns `{ messageId, streamToken }`. The stream handler calls `finalizeAiAssistantTurn` after provider completes.

**Client changes**:
- `src/components/ai/ai-chat-panel.tsx`: After `sendMessage` returns, open EventSource to `/api/ai/stream?...`. Render incoming deltas into the assistant message. On `proposals` event, render action cards. On error, fall back to current polling behavior.
- Add `src/hooks/use-ai-stream.ts`: Hook wrapping EventSource with reconnection + cleanup.

**CSP**: Must add `connect-src 'self'` (already present) — SSE to same origin works.

**Migration**: Add `isStreaming` and `streamToken` columns. No data migration needed — existing messages default to `isStreaming: false`.

---

### 2. Native Function/Tool Calling

**Why**: Current approach extracts proposals from markdown fences. This is fragile — LLMs often mangle JSON in fenced blocks. Native tool calling (OpenAI functions / Anthropic tool_use) is more reliable and enables multi-turn tool use.

**Approach**: When the provider adapter supports tool calling, send tool definitions alongside the prompt. The provider returns structured `tool_call` objects instead of/in addition to text. The orchestrator maps these to the existing `AiActionExecution` pipeline.

**Schema changes**: 
- Add `AiMessage.toolCalls` Json? — stores the raw tool_call array from the provider for the assistant message.
- Add `AiMessage.toolCallId` String? — maps to the provider's tool_call ID (for tool-result messages).
- No new enums needed — `AiMessageRole.tool` already exists.

**Server changes**:
- `src/server/services/ai/tools.ts`: Add `buildAiToolDefinitions()` that converts `AiActionType` enum to OpenAI/Anthropic tool schemas (name, description, parameters from existing Zod schemas).
- `src/server/services/ai/provider-openai-compatible.ts`: In the stream function, include `tools` array in the request. Handle `tool_calls` in the response stream. Emit SSE events for each tool call.
- `src/server/services/ai/provider-anthropic.ts`: Include `tools` in the Anthropic request. Handle `tool_use` content blocks.
- `src/server/services/ai/orchestrator.ts`: When provider returns tool calls, map each to `AiActionExecution` via existing `normalizeAiToolProposals` (or a new `normalizeAiNativeToolCalls`). Store raw calls in `AiMessage.toolCalls`. The `tool` role messages get `toolCallId` + `toolPayload` (already in schema).

**Fallback**: If provider doesn't support tool calling (e.g., custom OpenAI-compatible endpoint that strips tools), fall back to the current markdown-fence extraction. Detect by checking if the response contains `tool_calls` / `tool_use` content blocks.

**Client changes**: Minimal — the action proposal cards already render from `AiActionExecution` records. No change needed if the pipeline populates the same records.

---

### 3. Rich AI Proposal Rendering + Editing Before Approval

**Why**: Current proposals show raw JSON in a `<pre>` block. Users cannot edit a proposal before approving — they must reject and re-ask.

**Approach**: Replace the JSON `<pre>` with a typed form component per `actionType`. Add an "Edit & Approve" flow that lets users modify `proposedPayload` before execution.

**Schema changes**: None needed. The `proposedPayload` is already a JSON field that gets validated at execution time.

**Server changes**:
- `src/server/routers/ai.ts`: Modify `approveAction` to accept optional `overridePayload: Record<string, unknown>`. If provided, validate with `resolveAiActionPayload` and use it instead of `proposedPayload`. Store the override in `executedPayload`.

**Client changes**:
- `src/components/ai/ai-action-proposals.tsx`: For each proposal, render a typed form instead of `<pre>`. E.g., `moveStatus` shows a status dropdown, `editTask` shows editable fields, `createTask` shows a mini task form. Add "Edit & Approve" button that opens the form in editable mode. On submit, call `approveAction` with `overridePayload`.
- Add `src/components/ai/ai-proposal-forms.tsx`: Per-action-type form components that know the schema (reuse field components from task-detail.tsx where possible).

---

### 4. Gantt/Timeline View

**Why**: The existing "graph" tab is a dependency DAG on a time axis. It works for dependency inspection but doesn't show Gantt-style task bars with start→end duration. Users expect a Gantt chart.

**Approach**: Add a "gantt" view tab alongside list/board/graph/archive. Render horizontal bars from `startDate` to `dueDate`. Group by assignee or status. Support drag-to-reschedule.

**Schema changes**: None — `Task.startDate` and `Task.dueDate` already exist.

**Server changes**: None — existing `task.list` query returns all needed fields.

**Client changes**:
- Add `src/components/gantt/gantt-view.tsx`: New component. Renders a time axis (reuse from graph/), task bars as `<div>` positioned by startDate/dueDate. Group headers for assignee/status.
- Add `src/components/gantt/gantt-bar.tsx`: Single task bar with label, drag handles.
- `src/app/(dashboard)/[projectSlug]/page.tsx`: Add "gantt" to view tabs (5 tabs now). Conditionally render `<GanttView>`.

---

### 5. Calendar View

**Why**: Many users think in calendar terms (what's due this week?). No calendar view exists.

**Approach**: Add a "calendar" view tab. Render a month/week grid with task dots/bars on due dates. Click to open task detail.

**Schema changes**: None — uses `Task.dueDate`.

**Server changes**: None.

**Client changes**:
- Add `src/components/calendar/calendar-view.tsx`: Month/week grid component. Fetch tasks via existing `task.list` query. Place task indicators on due date cells.
- Add `src/components/calendar/calendar-day-cell.tsx`: Single day cell with task chips.
- `src/app/(dashboard)/[projectSlug]/page.tsx`: Add "calendar" to view tabs (6 tabs).

---

### 6. Dashboard/Analytics

**Why**: No overview of project health. Users cannot see velocity, burndown, status distribution, or overdue counts without manually scanning views.

**Approach**: Add a dashboard page at the project root or as a new tab. Compute aggregate metrics from existing data.

**Schema changes**: None initially. Metrics are computed at query time from existing data. If performance is a concern, add a `ProjectMetricsSnapshot` materialized model later.

**Server changes**:
- Add `src/server/routers/analytics.ts`: New router with `projectSummary` query (status distribution, overdue count, completion rate by week, avg cycle time). Uses Prisma aggregation queries.
- Mount in `src/server/routers/_app.ts`.

**Client changes**:
- Add `src/app/(dashboard)/[projectSlug]/dashboard/page.tsx` or add "dashboard" as first tab.
- Add `src/components/dashboard/dashboard-view.tsx`: Charts (bar for status dist, line for velocity/trend, number cards for overdue/total/avg cycle time).
- Use a lightweight chart library (recharts or simple SVG bars to avoid dependency bloat).

---

### 7. Sprints/Cycles

**Why**: Teams work in iterations. No sprint model exists.

**Approach**: Add Sprint model. Tasks get an optional `sprintId`. Sprint has start/end dates and a status (planning/active/completed).

**Schema changes**:
```prisma
enum SprintStatus {
  planning
  active
  completed
}

model Sprint {
  id        String       @id @default(cuid())
  projectId String
  name      String
  startDate DateTime
  endDate   DateTime
  status    SprintStatus @default(planning)
  goal      String?
  order     Int          @default(0)
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt

  project Project[]
  tasks   Task[]

  @@unique([projectId, name])
  @@index([projectId, order])
  @@index([projectId, status])
}
```
- Add `sprintId String?` to Task model, with relation `sprint Sprint? @relation(fields: [sprintId], references: [id], onDelete: SetNull)`.
- Add `@@index([projectId, sprintId])` to Task.

**Server changes**:
- Add `src/server/routers/sprint.ts`: CRUD (create, update, delete, list, startSprint, completeSprint). `startSprint` sets status=active, `completeSprint` moves incomplete tasks to next sprint or backlog.
- Mount in `_app.ts`.
- Modify `task.list` to accept `sprintId` filter.

**Client changes**:
- Add `src/components/sprint/sprint-picker.tsx`: Dropdown in task views to filter by sprint.
- Add sprint field to task create/edit forms.
- Add sprint management to project settings.
- Dashboard view shows sprint burndown if sprint is active.

**Migration**: Create Sprint table. Add nullable `sprintId` to Task. No data migration — existing tasks simply have no sprint.

---

### 8. Time Tracking

**Why**: No way to log time spent on tasks.

**Approach**: Add TimeLog model. Users can start/stop timers or manually log time. Aggregate on task detail and dashboard.

**Schema changes**:
```prisma
model TimeLog {
  id          String   @id @default(cuid())
  taskId      String
  userId      String
  description String?
  duration    Int      // seconds
  startedAt   DateTime
  endedAt     DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([taskId, startedAt])
  @@index([userId, startedAt])
}
```
- Add `timeLogs TimeLog[]` to Task relations.
- Add `timeLogs TimeLog[]` to User relations.

**Server changes**:
- Add `src/server/routers/time-log.ts`: CRUD + `startTimer`, `stopTimer` (creates TimeLog with endedAt=null for start, sets endedAt+duration for stop), `getTimeSummary` (aggregates by task/user/date range).
- Mount in `_app.ts`.

**Client changes**:
- Add timer button to `task-detail.tsx`.
- Add time log list/summary to task detail.
- Add time tracking column to list view.
- Dashboard shows time spent this week/sprint.

**Migration**: Create TimeLog table. No changes to existing tables (just new relations).

---

### 9. Workflow Automation Engine

**Why**: Users want rules like "when task moves to Done, auto-assign to QA" or "when due date is past, escalate priority". Currently manual.

**Approach**: Add AutomationRule model. A background evaluator runs rules on relevant events (task updated, status changed, etc.).

**Schema changes**:
```prisma
enum AutomationTrigger {
  statusChanged
  taskCreated
  taskAssigned
  dueDatePassed
  commentAdded
}

enum AutomationAction {
  moveStatus
  assignTask
  addTag
  removeTag
  addComment
  sendNotification
}

model AutomationRule {
  id          String            @id @default(cuid())
  projectId   String
  name        String
  isEnabled   Boolean           @default(true)
  trigger     AutomationTrigger
  triggerCondition Json?        // e.g., { fromStatusCategory: "active", toStatusCategory: "done" }
  action      AutomationAction
  actionPayload    Json          // e.g., { statusId: "..." } or { assigneeId: "..." }
  createdAt   DateTime          @default(now())
  updatedAt   DateTime          @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, isEnabled])
}
```
- Add `automationRules AutomationRule[]` to Project.

**Server changes**:
- Add `src/server/routers/automation.ts`: CRUD for rules.
- Add `src/server/services/automation-evaluator.ts`: Called from task activity hooks (after update, after status change, etc.). Queries active rules matching the trigger, evaluates conditions, executes actions via existing task router caller pattern (same as AI action executor).
- Mount in `_app.ts`.
- Wire evaluation calls into `task.ts` update mutation and `comment-service.ts`.

**Client changes**:
- Add automation rules management to project settings (`/[slug]/settings/automations`).
- Add rule creation form with trigger/action pickers.

**Migration**: Create AutomationRule table. No changes to existing tables.

---

### 10. Command Palette

**Why**: Power users want keyboard-driven navigation. The existing search modal (Cmd+K) searches tasks. A command palette extends this to actions (create task, switch view, change status, etc.).

**Approach**: Extend the existing `search-modal.tsx` into a full command palette. Add action commands alongside search results.

**Schema changes**: None.

**Server changes**: None (actions are client-side or call existing mutations).

**Client changes**:
- Refactor `src/components/ui/search-modal.tsx` into `src/components/ui/command-palette.tsx`.
- Add command registry: `src/lib/command-registry.ts` — defines commands (navigate, create task, switch view, set status, etc.) with keyboard shortcuts and action handlers.
- Add action results alongside search results in the palette UI.
- Commands call existing tRPC mutations or navigate to routes.

---

### 11. Recurring Tasks

**Why**: No way to create tasks that repeat (daily standup, weekly review, monthly report).

**Approach**: Add recurrence rule to Task. A cron job creates new task instances based on the rule.

**Schema changes**:
```prisma
enum RecurrenceFrequency {
  daily
  weekly
  monthly
  yearly
}

model RecurrenceRule {
  id          String              @id @default(cuid())
  taskId      String              @unique
  frequency   RecurrenceFrequency
  interval    Int                 @default(1) // every N frequency units
  dayOfWeek   Int?                // 0=Sun..6=Sat for weekly
  dayOfMonth  Int?                // 1-31 for monthly
  endDate     DateTime?           // stop after this date
  nextDueDate DateTime            // next occurrence
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([nextDueDate])
}
```
- Add `recurrenceRule RecurrenceRule?` to Task (1:1).

**Server changes**:
- Add `src/server/routers/recurrence.ts`: CRUD for rules. `setRecurrence`, `removeRecurrence`.
- Add `src/server/services/recurrence-processor.ts`: Queries rules where `nextDueDate <= now`, creates new tasks (via `createTaskWithNextNumber`), advances `nextDueDate`. Called by a cron endpoint or Next.js API route with a shared secret.
- Add `src/app/api/cron/process-recurring/route.ts`: API route protected by `CRON_SECRET` env var. Called by external scheduler (or node-cron in-process for single-instance deployments).
- Mount in `_app.ts`.

**Client changes**:
- Add recurrence controls to task detail (set frequency, interval, end date).
- Show recurrence badge on recurring tasks in all views.

**Migration**: Create RecurrenceRule table. Add optional 1:1 relation to Task.

---

### 12. Mobile/Offline/PWA

**Why**: No mobile-optimized experience. No offline support. Not installable.

**Approach**: Incremental — don't try to build a full offline-first architecture. Add PWA basics (manifest, service worker for caching), responsive layout improvements, and optimistic mutations.

**Schema changes**: None for MVP.

**Config changes**:
- `next.config.ts`: Add PWA headers. May need to relax CSP `connect-src` for service worker scope.
- Add `public/manifest.json`: PWA manifest with name, icons, start_url, display: standalone.
- Add basic service worker via `next-pwa` or a custom `public/sw.js` that caches static assets and API responses with stale-while-revalidate.

**Client changes**:
- Responsive layout: Audit `src/app/(dashboard)/[projectSlug]/page.tsx` and view components for mobile breakpoints. The 4-6 tab bar needs a compact mobile variant.
- Touch interactions: Ensure drag in board view and graph view work on touch devices.
- Optimistic updates: Already partially done (AI chat). Extend to task CRUD (create, update, delete) using tRPC's `onMutate` optimistic cache updates.

**Migration**: None.

**Risk**: Full offline with sync conflict resolution is a separate, large project. PWA MVP is just installability + basic caching.

---

## Implementation Sequence

### Phase 1: Foundation (Weeks 1-2)
1. **Prisma schema additions**: Sprint, TimeLog, AutomationRule, RecurrenceRule, AiMessage.isStreaming, AiMessage.toolCalls, AiMessage.toolCallId, AiConversation.streamToken. One migration, all new tables/columns. Existing data untouched.
2. **AI streaming**: Route handler + provider stream adapters + orchestrator refactor. This unblocks every subsequent AI improvement.
3. **Native tool calling**: Tool definitions + provider adapter changes. Depends on streaming being in place.

### Phase 2: AI UX + Views (Weeks 3-4)
4. **Rich proposal rendering + edit**: Client-side forms + server-side overridePayload.
5. **Gantt view**: New component, add tab to project page.
6. **Calendar view**: New component, add tab.
7. **Dashboard/analytics**: New router + view component.

### Phase 3: Sprint + Time + Automation (Weeks 5-6)
8. **Sprints/cycles**: New model + router + UI (sprint picker, settings).
9. **Time tracking**: New model + router + UI (timer, logs).
10. **Workflow automation**: New model + router + evaluator service + settings UI.

### Phase 4: Recurring + Command Palette + PWA (Weeks 7-8)
11. **Recurring tasks**: New model + cron processor + UI.
12. **Command palette**: Extend search modal.
13. **PWA basics**: Manifest + service worker + responsive audit.

---

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|------------|
| AI streaming: SSE connection drops mid-stream | User sees partial message | Client detects incomplete stream, falls back to polling `getConversation` which has the persisted message |
| Native tool calling: provider doesn't support tools | Proposals not extracted | Fallback to markdown-fence extraction (existing code path remains) |
| Sprint migration: adding nullable FK to Task | Performance on large tables | PostgreSQL adds nullable FK instantly; no table rewrite |
| Automation evaluator: infinite rule loops | Runaway CPU/DB | Add recursion guard — max 3 automation actions per event, with 1-second debounce |
| Recurring tasks: cron not running | Tasks not created | Cron endpoint returns health status; monitor with external uptime check |
| PWA: service worker caching stale API data | Users see outdated tasks | Use network-first strategy for API, cache-first for static assets |
| Schema migration size: 4 new tables at once | Migration risk | All new tables are independent; migration is additive only, no column renames or type changes |

## Next Steps
- Validate schema additions with `prisma validate`
- Implement Phase 1 (streaming + tool calling) first as it has the most architectural impact
- Add feature flags (in Project.settings JSON) for each new view tab to allow gradual rollout