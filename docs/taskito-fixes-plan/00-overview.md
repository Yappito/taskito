# Taskito Fixes — Phase Plan

**Repo:** taskito (Next.js 15 / tRPC / Prisma / PostgreSQL)
**Date:** 2026-08-03
**Branch:** `loop/taskito-fixes-20260803`
**Source:** Quality-pass review (`taskito-review-opencode.md`, 61 findings: 7 critical / 16 high / 21 medium / 17 low) + Bence's directives.
**Baseline:** 89 tests passing (26 files), `npm run build` passes, `tsc --noEmit` fails on 1 test file (ai-provider-validation.test.ts:39), eslint 1 warning.

## Bence's directives (from the critical-finding review)

1. **SSRF (S1/S5):** Private and loopback AI provider hosts MUST be allowed. Protection = DNS-resolution re-check + host allowlist enforcement at fetch time + `redirect: "manual"` + never leak decrypted API keys to redirect targets.
2. **User provider registration (S2):** Registration stays open to authenticated users (intentional). But users must NOT be able to decrypt already-saved API keys → `revealProviderSecret` becomes admin-only (all scopes).
3. **CSP unsafe-eval (C1):** Remove `'unsafe-eval'` from production CSP in `nginx.conf` (keep dev-only in `next.config.ts`).
4. **TLS (C2/C3):** Caddy reverse proxy terminates TLS in front of the app container. Fix = app-side: require `AUTH_URL` (https) in production, derive secure cookies / trustHost correctly behind the proxy, document Caddy config (HSTS, forwarded headers). No TLS inside the app container itself.
5. **Checkpoint sprintId (B1):** Investigate and fix — snapshot/restore must include `sprintId`.
6. **Analytics take:500 (B2):** Investigate and fix — use proper counts, not truncated arrays.
7. **Recurrence race (B3):** Investigate and fix — atomic create+advance, no swallowed errors.
8. **All high findings:** fix.

## High findings in scope

| ID | Finding | Fix |
|----|---------|-----|
| S3 | `testProvider` skips `ai_manage` for project scope | require `ai_manage` for project-scoped providers in `testProvider` (mirror `revealProviderSecret`) |
| S4 | Master key falls back to `SHA256(AUTH_SECRET)` | production: require `AI_SECRET_MASTER_KEY` (no silent fallback); dev: keep fallback with warning; validate length |
| S5 | Secret sent to redirect targets | `redirect: "manual"` on all provider fetches; fail on 3xx |
| B4 | `dayOfWeek`/`dayOfMonth` stored but never applied | implement in recurrence processor |
| B5 | Cursor pagination over non-unique `orderBy: dueDate asc` unstable | add `id` tiebreaker (or `taskNumber`) to orderBy |
| B6 | `sprint.list` orders by enum alphabetically | order by workflow order (status ordering via `order` field or case mapping) |
| B7 | Yolo mode `Promise.all` parallel actions | serialize execution |
| B8 | Checkpoint capture + execution not transactional | wrap execute+persist in transaction; checkpoint after success |
| B9 | `deleteStatus` no pre-check, opaque FK error | pre-check tasks using status; friendly error |
| C4 | `prisma migrate deploy` as app user on every replica | dedicated migration step/init container; app role least-privilege |
| C5 | Weak/placeholder example secrets | expand invalid-secret blocklist; boot validation for master key |
| C6 | No container hardening | read-only fs where feasible, cap_drop, no-new-privileges, non-root (already non-root), resource limits |
| C7 | Pervasive `onDelete: Cascade` on Project/User | audit schema; restrict user-deletion cascades, keep project cascade deliberate |
| C8 | Untyped `Json` columns | zod validation at tRPC boundaries for Json inputs |
| C9 | No CI gate for lint/typecheck/test/build | GitHub Actions workflow on PR/push |
| T1/T2 | Untested critical AI + recurrence paths | add tests alongside fixes |

## Phases

### Phase 1 — AI provider security (SSRF + authz + secret handling)
**Covers:** S1, S2, S3, S4, S5, C5 (secrets part), B5-adjacent test fix.
**DoD:**
- `assertAiProviderBaseUrlFetchAllowed` resolves DNS and: allows loopback + private IPs (per Bence); enforces `AI_PROVIDER_HOST_ALLOWLIST` when set (hostname + resolved IPs); rejects unresolvable hosts; blocks nothing else by default.
- All provider fetches use `redirect: "manual"`; 3xx → error. No Authorization/x-api-key leak on redirects.
- `revealProviderSecret` requires global admin for ALL scopes.
- `testProvider` requires `ai_manage` for project-scoped providers.
- `secret-crypto.ts`: in production, `AI_SECRET_MASTER_KEY` required (throw if unset, no AUTH_SECRET fallback); dev fallback logs a warning; length check on fallback.
- `AUTH_SECRET` invalid blocklist extended with `.env.example` placeholder.
- `tsc --noEmit` passes (fixes the ai-provider-validation test type error).
- Tests: new/updated for DNS allowlist behavior, redirect handling, authz gates, master key policy. 89+ baseline tests still pass.

### Phase 2 — Recurrence correctness
**Covers:** B3 (critical), B4 (high), T2.
**DoD:**
- `processDueRecurrences`: per-rule `$transaction` — task create + `nextDueDate` advance atomic; no swallowed errors (log + continue or mark failed rule).
- `dayOfWeek`/`dayOfMonth` applied when set (weekly → next weekday; monthly → day-of-month).
- Unit tests for recurrence processor (atomicity via mock, dayOfWeek/dayOfMonth scheduling, endDate boundary).
- All tests pass.

### Phase 3 — AI action atomicity (checkpoints + yolo)
**Covers:** B1 (critical), B7, B8 (high), T1.
**DoD:**
- `TaskSnapshot` includes `sprintId`; restore writes it back.
- Yolo execution serialized (sequential, not `Promise.all`).
- Execute+persist wrapped in a transaction; checkpoint captured after successful execution; failures recorded with status `failed` and message.
- Tests: checkpoint round-trip preserves sprintId; serialized yolo execution; rollback after failed execution.
- All tests pass.

### Phase 4 — Analytics, pagination, sprint order, status deletion
**Covers:** B2 (critical), B5, B6, B9 (high).
**DoD:**
- `analytics.projectSummary`: uses `task.count`/`groupBy` for totals and distributions; `take: 500` only for the at-risk list (or removed entirely); velocity via `groupBy` on `createdAt`/`closedAt`.
- `task.list` cursor pagination: stable orderBy (e.g. `[{ dueDate: "asc" }, { taskNumber: "asc" }]` with cursor on id or taskNumber).
- `sprint.list`: workflow-order (planned → active → completed or via `order` field).
- `deleteStatus`: pre-check `task.count({ where: { statusId } })`; return friendly error if in use (or require a target status + move, per repo conventions).
- All tests pass; `tsc` clean.

### Phase 5 — Config / deployment / CI
**Covers:** C1, C2, C3 (criticals), C4, C5, C6, C9 (highs).
**DoD:**
- `nginx.conf`: prod CSP without `'unsafe-eval'`.
- `auth.ts`: production requires `AUTH_URL` (https) when behind proxy; `trustHost` derived from `AUTH_URL` presence; cookie `secure` flag set correctly via `x-forwarded-proto`; Caddy config documented in README (HSTS, X-Forwarded-For).
- `docker-compose.yml`: dedicated `migrate` one-shot service (or init container) running `prisma migrate deploy` before app start; app no longer runs migrations itself; container hardening (read_only where possible, `cap_drop: [ALL]`, `security_opt: no-new-privileges`, tmpfs for `/tmp` if needed); resource limits.
- `.env.example`: strong generated secrets, `AI_SECRET_MASTER_KEY` documented as required in prod.
- CI: `.github/workflows/ci.yml` — lint, tsc, vitest, build on PR + push to main.
- `docker compose config` validates; app builds and boots (if docker available for smoke test).

### Phase 6 — Schema hardening (cascades + JSON validation)
**Covers:** C7, C8 (highs).
**DoD:**
- Prisma schema audit: user-related cascades reviewed — deleting a user must not silently nuke owned tasks/comments; project cascade kept deliberate; migration created and applied.
- Json columns validated at router boundaries (zod schemas) where inputs flow into Json fields.
- Migration file committed; `prisma migrate dev` works against a fresh Postgres (docker).
- All tests pass.

## Execution notes

- Model: `opencode-go/deepseek-v4-flash --variant max` per phase; retry #2 on `zai-coding-plan/glm-5.2` (Ollama quota exhausted; OpenAI token invalidated).
- No direct commits to main; force-push forbidden; push only at Stage 2; PR via `gh pr create`.
- Baseline test command: `npm test` (89 tests). Full check after each phase: `npm test && npx tsc --noEmit && npm run build`.
