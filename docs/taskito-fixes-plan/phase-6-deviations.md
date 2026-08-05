# Phase 6 Deviations

## Cascade decisions (T6.1, per-finding)

| Relation | Change | Rationale |
|----------|--------|-----------|
| `Comment.authorId` | `String` → `String?`, `onDelete: SetNull` | Deleting a user keeps their comments; UI shows "User" fallback |
| `AiConversation.createdByUserId` | `String` → `String?`, `onDelete: SetNull` | Conversations survive user deletion; `createdByUser` nullable |
| `AiActionExecution.requestedByUserId` | `String` → `String?`, `onDelete: SetNull` | Audit rows survive; `requestedByUser` nullable |
| `AiActionExecution.executedByUserId` / `rolledBackByUser` | already nullable + `SetNull` | no change |
| Task creator/assignee | kept as-is (not cascade; checked — `onDelete` default `Restrict`/`SetNull` per relation) | task ownership semantics unchanged |
| Project-owned tree cascade | kept | project delete = intentional nuke of project scope |

Verified live: migration applied cleanly to a throwaway Postgres 16 container (`taskito-phase6-pg`), `prisma migrate deploy` exit 0.

## Deviations from the phase spec

1. **`src/components/task/task-detail.tsx:996`** — `comment.author.name` → `comment.author?.name` (author becomes nullable). This file is outside the phase scope list, but the schema change makes it a compile error; minimal null-guard applied.
2. **Description schema leniency** — the new `taskDescriptionSchema` accepts `string | Record<string, unknown> | null` (TipTap JSON object, string, null); rejects arrays/numbers/booleans. Lenient by design per T6.3 ("no rejecting previously-valid data").
3. **Test cast fix (Hermes post-fix)** — the session left 5 `tsc` errors in `task-description-validation.test.ts` (`as unknown` is not assignable to the input param type). Changed to `as never` (6 occurrences), which is the standard way to pass intentionally-invalid values past the type system while still exercising zod rejection at runtime. No test semantics changed.
4. **DB-level SetNull not unit-tested** — vitest mocks Prisma, so FK behavior is verified by the live migration apply, not a unit test (per plan: "verified live rather than unit-tested").

## Post-session verification (Hermes)

- `npm test`: 136 passed (33 files) — baseline 126 + 10 new
- `npx tsc --noEmit`: clean (after the `as never` fix)
- `npm run build`: passes
