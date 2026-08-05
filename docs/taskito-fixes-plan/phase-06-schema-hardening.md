# Phase 6: Schema hardening (cascades + JSON validation)

## Context

Highs C7 (pervasive `onDelete: Cascade` on Project/User can nuke large datasets) and
C8 (untyped `Json` columns with no validation at the Prisma boundary) from
`docs/taskito-fixes-plan/00-overview.md`. This phase touches the Prisma schema and
creates a migration — coordinate carefully with Phase 5's compose changes (migrate
service will apply it).

## Scope (files you may touch)

- `prisma/schema.prisma`
- New migration under `prisma/migrations/` (generated via `prisma migrate dev`)
- `src/server/routers/*.ts` (only the specific routers with Json inputs needing zod validation)
- `src/server/services/*.ts` (only if a Json write path needs a validation helper)
- Tests: `src/server/routers/__tests__/` (validation rejection tests)
- `docs/taskito-fixes-plan/STATUS.md`

## Tasks

### T6.1 — Cascade audit
In `prisma/schema.prisma`, audit `onDelete` relations. Principles:
- Project deletion DELETING its tasks/statuses/etc. is intended (project delete =
  delete everything) — keep project cascade for the project-owned tree where it
  exists, but review whether it should be `Restrict` + explicit service-level
  cascade (if the app already deletes project children in a transaction, switch FK
  to Restrict to prevent accidental raw deletes).
- User deletion should NOT silently nuke data owned by the user:
  - `Task.creatorId` / `Task.assigneeId` → `SetNull` (or `Restrict` if the app
    requires a user on tasks — check app logic; prefer SetNull and let the app
    surface "deleted user" via null).
  - `Comment.authorId` → `SetNull` (keep comments when user is deleted).
  - `TaskActivityEvent.actorId` → `SetNull`.
  - `AiConversation.createdByUserId` → `SetNull` (or Restrict — conversations lose
    meaning without a creator; prefer SetNull + keep rows).
  - `AiActionExecution.requestedByUserId` / `executedByUserId` → `SetNull`.
  - `GroupMember.userId`, `ProjectMember.userId` → `Cascade` is fine (membership is
    a join row owned by the user).
  - Watchers/subscriptions join rows → Cascade (join rows, fine).
- Check every `User`-referencing relation and every `Project`-referencing relation
  in the schema; document each decision in the phase file's deviations/comments.
- Do NOT break the `createTaskWithNextNumber` uniqueness or the task-number logic.

### T6.2 — Migration
- After editing `prisma/schema.prisma`, generate a migration:
  - Needs a Postgres. If docker is available: run a throwaway postgres container
    (e.g. `docker run -d -e POSTGRES_PASSWORD=... -p 5433:5432 postgres:16-alpine`),
    set `DATABASE_URL=postgresql://postgres:...@localhost:5433/taskito`, then
    `npx prisma migrate dev --name user_relations_set_null` (or a name matching the
    actual change).
  - If no docker/DB available: `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` to generate SQL and hand-write the migration folder (name, migration.sql, migration_lock.toml if missing). Prefer the real migrate dev path.
- The migration must be additive/safe for existing deployments (SetNull on
  nullable columns; no column drops; no data loss).
- Run `npm run db:generate` after schema changes.

### T6.3 — Json column validation
Audit `Json` fields in the schema and add zod validation at the tRPC boundary where
client input flows into Json columns. At minimum:
- `CustomFieldValue.value` — validate against the custom field's type if the router
  knows it (at minimum: value must be string/number/boolean/null or array/object of
  those — a safe generic schema). Find the write path (likely
  `src/server/routers/custom-field.ts` or task update) and add validation.
- `AiProjectPolicy.defaultPermissions` / `maxPermissions` — already normalized via
  `normalizeAiPermissions` (verify; if already validated, no change needed).
- `AiProviderConnection.defaultHeaders` — already validated by
  `normalizeAiProviderHeaders` (verify).
- `DashboardWidget.config` (or whatever the dashboard widget Json column is called) —
  add a zod schema matching the widget types.
- `Task.description` / `Task.body` — if Json columns, validate shape (object/null).
- Do not add validation that rejects previously-valid data — keep schemas lenient
  (e.g. `z.unknown()` for nested values unless the write path clearly constrains it).
- The goal: no path where raw client JSON lands in a Json column unvalidated.

### T6.4 — Tests
- For each router where a new zod schema was added: a rejection test (invalid input
  → error) and an acceptance test (valid input passes).
- If `SetNull` changes affected app logic: update/extend router tests for user
  deletion paths (find the user-deletion router/service and test that deleting a
  user with tasks/comments succeeds and nulls references instead of failing or
  cascading).

## Definition of done

1. Schema cascade decisions documented; user-deletion no longer nukes owned data;
   project tree cascade deliberate.
2. Migration generated and committed; `prisma migrate dev` applies cleanly to a
   fresh DB (docker) — verified by orchestrator.
3. `npm run db:generate` succeeds.
4. Json write paths validated at the boundary.
5. New tests pass; `npm test` (all), `npx tsc --noEmit`, `npm run build` all pass.
6. No invariants broken (task-number uniqueness, AI secret format, response shapes).
