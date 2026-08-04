# Taskito Fixes — Invariants (do not break)

## Repository rules

- Main branch: never commit to main, never reset, never force-push (incl. `--force-with-lease`).
- All work on `loop/taskito-fixes-20260803`; push only at finalization.
- Tests: `npm test` (vitest, 89 baseline). Lint: `npm run lint`. Typecheck: `npx tsc --noEmit`. Build: `npm run build`.
- Prisma: `npm run db:generate` after schema changes; migrations via `prisma migrate dev --name <name>`.
- No `any`, no `@ts-ignore`, no `console.log` in src (repo is zero-tolerance on these — keep it that way).

## Domain invariants (no phase may rename/remove)

- AI provider adapters: `openai_compatible` | `anthropic` (enum values in `prisma/schema.prisma` AiProviderAdapter + `src/server/services/ai/provider-registry.ts`).
- AI provider scopes: `user` | `project` | `shared` (used across ai.ts router, stream route, sanitize helpers).
- AI permission model: `src/lib/ai-types.ts` — `AI_PERMISSION_PRESETS`, `AI_PERMISSION_VALUES`; used by policy default/max permissions.
- AI secret encryption: `encryptSecret`/`decryptSecret` in `src/lib/secret-crypto.ts` (aes-256-gcm, 12-byte IV, 16-byte tag). Output format `iv||tag||ciphertext` base64 must stay decryptable — no format change without a migration path.
- `AI_SECRET_MASTER_KEY` = base64 32-byte key; `AUTH_SECRET` ≥ 32 chars in production.
- Host allowlist env: `AI_PROVIDER_HOST_ALLOWLIST` (comma-separated hostnames).
- Rate limit buckets: `src/lib/rate-limit.ts` `consumeRateLimit(bucket, key, opts)` — bucket names `ai-chat`, `ai-provider-test`, `login:account`, `login:ip` are referenced in multiple files.
- Task number allocation: `createTaskWithNextNumber` in `src/server/routers/task.ts` — unique `(projectId, taskNumber)`; retry on P2002; must stay atomic and keep the transaction-client factory signature.
- Recurrence: `prisma.recurrenceRule` fields `frequency`, `interval`, `dayOfWeek`, `dayOfMonth`, `nextDueDate`, `endDate`; processor in `src/server/services/recurrence-processor.ts`; endpoint `/api/cron/process-recurring` with `CRON_SECRET` bearer auth.
- Analytics router `analytics.projectSummary` response shape (client depends on it): `totalTasks`, `activeTasks`, `completedTasks`, `overdueTasks`, `completionRate`, `avgCycleTimeHours`, `loggedSeconds`, `statusDistribution`, `priorityDistribution`, `velocity`, `atRiskTasks`.
- Task list pagination contract: `{ items, nextCursor, totalCount }`; cursor is task id.
- AI action execution statuses: `proposed` | `approved` | `executed` | `failed` (AiActionExecution.status).
- Checkpoint shape `AiActionCheckpoint` (version 1) — adding fields is fine; removing/renaming fields is not.
- Auth: `AUTH_URL`, `AUTH_SECRET`, `AUTH_TRUST_HOST` env contract; session cookie names `authjs.session-token` / `__Secure-authjs.session-token`.
- Container: app runs as user `nextjs` (uid 1001) in Docker; `PORT=3000`, `HOSTNAME=0.0.0.0`; uploads at `/app/uploads`.
- tRPC: all routers created via `createTRPCRouter`, procedures via `protectedProcedure` (auth required). `requireProjectAccess(prisma, userId, projectId, { permission })`, `requireGlobalAdmin`, `requireTaskAccess` in `src/server/authz.ts`.

## Client-facing UI contract

- AI action cards render inline in the chat timeline (do not move them to a separate block).
- Optimistic user messages deduplicated once persisted message arrives (keep behavior).
- Task references resolve by id, `PROJECT-123` key, or exact title when unique (keep).
- Custom dashboards, themes, S3 upload storage: existing feature behavior must not regress (Phases touch only listed files).

## Files phases may touch (scope boundary)

- Phase 1: `src/lib/ai-provider-validation.ts`, `src/lib/secret-crypto.ts`, `src/server/services/ai/provider-openai-compatible.ts`, `src/server/services/ai/provider-anthropic.ts`, `src/server/routers/ai.ts`, `src/server/services/ai/action-executor.ts` (only if needed for authz), `.env.example` (AUTH_SECRET placeholder), tests under `src/lib/__tests__/` + `src/server/routers/__tests__/`.
- Phase 2: `src/server/services/recurrence-processor.ts`, `src/server/routers/recurrence.ts` (only if schema semantics need wiring), `src/lib/date-utils.ts` (if shared helpers), tests `src/server/services/__tests__/recurrence-processor.test.ts`.
- Phase 3: `src/server/services/ai/checkpoints.ts`, `src/server/services/ai/orchestrator.ts`, `src/server/services/ai/action-executor.ts`, tests under `src/server/services/ai/__tests__/`.
- Phase 4: `src/server/routers/analytics.ts`, `src/server/routers/task.ts` (pagination only), `src/server/routers/sprint.ts` (list order only), `src/server/routers/workflow.ts` (deleteStatus only), tests.
- Phase 5: `nginx.conf`, `docker-compose.yml`, `Dockerfile`, `src/lib/auth.ts`, `src/middleware.ts` (only if cookie/proto handling needs alignment), `.env.example`, `README.md` (Caddy docs), `.github/workflows/ci.yml` (new).
- Phase 6: `prisma/schema.prisma`, new migration under `prisma/migrations/`, `src/server/routers/*.ts` (zod validators on Json inputs), tests.

Anything outside these files: ask before touching.
