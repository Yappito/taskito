# Features Since Last Commit

Since commit `d80815b` (`UI overhaul, security fixes`), Taskito has gained a full in-app AI workspace and the supporting persistence, policy, security, and UX layers required to run it safely inside the product.

## AI Foundation

- Added Prisma schema and migrations for AI providers, project AI policy, conversations, messages, action executions, and rollback checkpoints.
- Added shared AI types, permission helpers, provider validation helpers, encrypted secret storage, and provider timeout handling.
- Added provider adapters for `openai_compatible` and `anthropic` remote APIs.
- Added planning and implementation docs:
  - `AI_CHAT_INTEGRATION_PLAN.md`
  - `AI_CHAT_IMPLEMENTATION_TRACKER.md`
  - `AI_CHAT_DECISIONS.md`
  - `AI_CHAT_TEST_PLAN.md`

## Provider And Policy Management

- Added personal AI provider management inside `Settings -> AI`.
- Added project AI settings at `/<projectSlug>/settings/ai`.
- Providers can now be:
  - user-scoped
  - project-scoped
- Providers support:
  - enabled/disabled state
  - default provider selection
  - reveal-secret flow
  - real provider test request
- Project AI policy now supports:
  - default provider
  - personal-provider allowance
  - project-provider allowance
  - `Yolo mode` allowance
  - default conversation permissions
  - maximum allowed permissions

## Contextual AI Chat

- Added AI launchers for:
  - whole-project chat
  - selected tasks in list view
  - selected tasks in board view
  - individual task detail views
- Added conversation persistence and history.
- Added generated chat titles so prior conversations are easier to identify in the history dropdown.
- Added compact loaded-context inspection for the current project, task, or selected-task scope.
- Added optimistic user message bubbles so sent prompts appear immediately.
- Added markdown rendering for assistant replies, including headings, lists, emphasis, and code blocks.
- Added persistent `Enter sends` preference storage.
- Preserved draft permission selections when starting a new chat session from the same AI panel.

## AI Actions And Execution

- Added approval-based AI write proposals by default.
- Added explicit per-conversation `Yolo mode` for automatic execution when project policy allows it.
- Added support for AI proposals that can:
  - add comments
  - add links
  - remove links
  - move task status
  - assign tasks
  - edit task core fields
  - edit tags
  - edit custom fields
  - bulk update selected tasks
  - create tasks
  - duplicate tasks
  - archive tasks
  - unarchive tasks
- AI task linking now resolves task keys such as `ABC-12` and normalizes dependency wording like `depends_on` into Taskito link semantics.
- Bulk AI updates are limited to the selected tasks in the conversation.
- AI-generated task creation now validates required fields like `title` and `dueDate`.

## Safety, Audit, And Rollback

- AI executions run as the current signed-in user instead of a service identity.
- Provider and policy state are revalidated at send-time and approval-time.
- Each proposal and execution is persisted with title, summary, payload, status, and result.
- Added before/after checkpoints for tasks, links, comments, and AI-created tasks.
- Added rollback support for executed AI changes with conflict-aware restore logic.
- Executed AI actions now render as compact entries that can still be reopened for detail inspection and rollback.

## Prompt And Context Improvements

- AI conversations now receive bounded project task context.
- Current date/time is injected into the system prompt.
- Prompt guidance now warns against inferring past due dates from stale tasks.
- Prompt guidance now instructs the model to use Taskito's actual link model.
- Proposal parsing now tolerates fenced `json` blocks in addition to explicit `proposal` blocks.

## Provider Security And Hardening

- AI provider secrets are encrypted before persistence.
- Provider calls are server-side only.
- Provider URL validation now enforces:
  - HTTP/HTTPS only
  - HTTPS unless explicitly allowlisted
  - loopback blocking
  - private/reserved IP blocking
  - DNS resolution checks
- Reserved headers such as `Authorization`, `x-api-key`, and `anthropic-version` cannot be overridden by user-supplied defaults.
- AI provider request timeout is configurable via `AI_PROVIDER_REQUEST_TIMEOUT_MS`.
- Timeout errors now surface as clearer provider timeout failures instead of raw abort messages.

## Additional UX Changes

- Removed the dashboard's left sidebar.
- Moved the main `Settings` link into the top bar.
- Kept project-level AI entry points visible from the project header.

## Verification Status

- AI-related unit coverage now includes crypto, permissions, provider validation, tool parsing, provider timeout helpers, presenter parsing, and title normalization.
- Current local verification passes:
  - `npm test`
  - `npm run build`
- Remaining verification gap from the tracker:
  - router/service integration coverage
  - AI-specific end-to-end coverage
