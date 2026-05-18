# AGENTS

## Project

- Repo: `taskito`
- App: Taskito, a self-hosted task manager with board, list, archive, dependency graph, comments, attachments, notifications, and an in-app AI workspace
- Stack: Next.js 15 App Router, React 19, TypeScript, tRPC, Prisma, PostgreSQL, Tailwind CSS 4, Auth.js

## Core Commands

- Install: `npm install`
- Dev server: `npm run dev -- -p 3001`
- Tests: `npm test`
- Build: `npm run build`
- Prisma generate: `npm run db:generate`
- Prisma migrate deploy: `./node_modules/.bin/prisma migrate deploy`

## AI Workspace

- AI launch points exist for project chat, task chat, and selected tasks in board/list views
- Supported provider adapters: `openai_compatible`, `anthropic`
- Providers can be user-scoped or project-scoped
- AI write actions are approval-first by default, with optional project-gated `Yolo mode`
- Supported AI write actions include:
  - add comments
  - add/remove task links
  - move status
  - assign tasks
  - edit task core fields, tags, and custom fields
  - bulk update selected tasks
  - create, duplicate, archive, and unarchive tasks
- AI context includes project data plus task descriptions and recent comments where relevant
- Executed AI actions are audited and support rollback checkpoints

## Current Behavior Notes

- AI action cards render inline in the chat timeline rather than in a separate block below messages
- Optimistic user messages are deduplicated once the persisted message arrives
- AI link resolution accepts task ids, task keys like `PROJECT-123`, and exact task titles when unambiguous
- Task number allocation retries on unique conflicts during task creation and duplication

## Latest Pull Highlights

- `40ff96a` `fixes`
  - deduplicates optimistic user messages in the AI chat once matching persisted messages arrive
- `28ad682` `fix: keep ai actions inline and restore link resolution`
  - keeps AI action proposal cards inline with the related assistant turn
  - restores task link resolution for AI proposals
  - task references can resolve by exact title when unique within a project
- `530533a` `AI fixes`
  - includes task-router fixes related to current AI/task flows
- `72fce04` `fix: retry task number allocation on conflicts`
  - retries task number assignment when concurrent writes hit a unique constraint conflict
- `26ff395` `fix: polish ai chat and task detail interactions`
  - further AI chat UX polish and task detail interaction cleanup

## Environment Notes

- Dev URL: `http://localhost:3001`
- Demo login commonly used in local dev:
  - email: `admin@taskito.local`
  - password: `taskito-demo-2026`
- AI-related env vars:
  - `AI_SECRET_MASTER_KEY`
  - `AI_PROVIDER_HOST_ALLOWLIST`
  - `AI_PROVIDER_REQUEST_TIMEOUT_MS`

## Important Files

- `README.md`: setup and product overview
- `FEATURES_SINCE_LAST_COMMIT.md`: AI and release-style summary
- `src/components/ai/`: AI UI
- `src/server/routers/ai.ts`: AI tRPC routes
- `src/server/services/ai/`: AI orchestration, providers, tools, checkpoints
- `src/server/routers/task.ts`: task creation, duplication, and task number allocation
