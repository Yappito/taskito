---
agent: security-auditor
created: "2026-05-12T13:00:00Z"
scope: working-tree
type: security-review
confidence: high
---

## Summary

Security audit of the current working tree changes covering: /api/ai/stream auth/rate-limit/secret-leakage/client-disconnect, native function calling, overridePayload in approveAction, automation rules/evaluator recursion, PWA service worker cache strategy, time tracking privacy/authorization, recurrence cron endpoint, and dashboard aggregations.

## Findings

### F1: /api/ai/stream — no CSRF protection (Medium)

- The stream endpoint is a plain Next.js Route Handler (`POST /api/ai/stream`) that authenticates via `auth()` session.
- The middleware only checks session existence, not CSRF tokens.
- tRPC mutations are protected by Next.js CSRF cookie-based mechanism, but the stream endpoint bypasses tRPC entirely.
- A malicious site can issue a cross-origin `POST` with credentials (cookies) to trigger AI completions on behalf of a logged-in user.

### F2: /api/ai/stream — no per-conversation dedup / stale-orphan detection (Low)

- If a client disconnects mid-stream, the server continues the provider request and persists messages/executions.
- No `streamToken` mechanism is present in the schema (the column was added but unused).
- A reconnecting client creates a duplicate user message and triggers a second completion.

### F3: overridePayload in approveAction — privilege escalation vector (Medium)

- `approveAction` now accepts `overridePayload: z.record(z.string(), z.unknown()).optional()`.
- When provided, the override payload is resolved and validated, then used as the execution payload.
- The check `assertAiActionStillAllowed` validates permissions against the overridden payload, which is correct.
- However, the `proposedPayload` on the `AiActionExecution` record is **not** updated — only `executedPayload` is set to the override.
- An approver can change any field in the payload (e.g., change `taskId` to target a different task, change `statusId` to move to an unauthorized status) as long as the new payload passes the same permission check.
- The original proposal was approved by the user viewing specific fields, but the override could change the target task or action scope.

### F4: Automation evaluator — recursion depth is a module-level global (Medium)

- `automationDepth` is a module-level variable (`let automationDepth = 0`).
- In serverless/edge runtime, this variable persists across requests within the same cold-start instance.
- If a request throws before the `finally` block decrements, the depth counter leaks permanently, blocking all future automation.
- The guard `isAutomationExecutionActive()` checks `automationDepth > 0`, so a leaked counter disables automation entirely for the instance lifetime.

### F5: Automation evaluator — no authorization check on action payload (Medium)

- `executeAutomationAction` creates a tRPC caller with `role: "member"` and the event's `actorId`.
- For `moveStatus` and `assignTask`, the payload's `statusId`/`assigneeId` come directly from user-controlled `actionPayload` JSON stored in `AutomationRule`.
- The `triggerCondition` is also user-controlled JSON with no schema validation beyond `z.record(z.string(), z.unknown())`.
- A project owner could create a rule with `actionPayload: { statusId: "<any-status>" }` that moves any task to any status, including bypassing workflow transitions.
- The task router's `update` mutation does check `requireWorkflowStatusAccess`, but only for the target status existence and project membership, not transition validity.

### F6: PWA service worker — caches all GET responses indiscriminately (Low)

- `sw.js` caches all same-origin GET responses (excluding `/api/`) via a cache-first strategy.
- No `Vary` header check, no cache-busting on deployment, and no max-age/expiration.
- Static assets with hashed filenames are safe, but the root `/` HTML shell is cached and could serve stale app shell after deployments.

### F7: Time tracking — summary exposes other users' total time (Low)

- `timeLog.summary` allows any project member to see `totalSeconds` (aggregate of all users' time) and `running` (any user's running timer in the project).
- The `running` timer object includes `userId`, `description`, and `startedAt` of whichever user has an active timer.
- This is likely intentional for project visibility, but could be a privacy concern in organizations where individual time tracking is sensitive.

### F8: Analytics — no pagination limit enforcement beyond take(500) (Low)

- `analyticsRouter.projectSummary` loads up to 500 tasks with full includes (status, assignee, sprint, timeLogs).
- The `timeLog.aggregate` on line 43-46 has no date filter, computing total logged time across all time.
- No authorization issue (requires project membership), but could be a performance concern for large projects.

### F9: recurrence.processDue — owner-only endpoint for task creation (Low)

- `processDue` requires `minimumRole: "owner"`, which is appropriate.
- `processDueRecurrences` creates tasks with `creatorId: source.creatorId` (the original task's creator), not the caller.
- No authorization bypass, but the created task attribution goes to a user who may not have initiated the action.

### Non-findings (reviewed, no material issue)

- **AI provider secret handling**: Secrets are AES-256-GCM encrypted at rest, decrypted only at request time. No leakage in API responses (sanitized via `sanitizeProviderForList`).
- **Native tool calling**: `buildAiToolDefinitions` correctly filters by granted permissions. `normalizeAiNativeToolCalls` validates via the same `normalizeAiToolProposals` path.
- **Rate limiting**: Stream endpoint uses `consumeRateLimit("ai-chat-stream", ...)` with 20/min/user. tRPC `sendMessage` uses `consumeRateLimit("ai-chat", ...)` with 20/min/user. These are separate buckets, so a user can do 40 requests/min total across both endpoints.
- **DNS rebinding protection**: `assertAiProviderBaseUrlFetchAllowed` resolves the hostname via DNS and returns the normalized URL, but does not validate that the resolved IP is not a private/internal address. This was pre-existing, not introduced in this diff.

## Next steps

- Add CSRF protection or SameSite enforcement for `/api/ai/stream`.
- Consider restricting overridePayload to a subset of fields or requiring re-confirmation.
- Replace module-level `automationDepth` with AsyncLocalStorage or a request-scoped mechanism.
- Add schema validation for `triggerCondition` and `actionPayload` in automation rules.