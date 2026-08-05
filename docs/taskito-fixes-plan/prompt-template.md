# Taskito Phase Prompt Template

Fill `{BRACES}` per project; `<N>` and `<N, zero-padded>` filled at launch time.

---

You are implementing one phase of a pre-approved implementation plan in this
repository (Taskito — Next.js 15 App Router / React 19 / TypeScript / tRPC / Prisma /
PostgreSQL — see `AGENTS.md`). The plan was written against this exact codebase;
your job is faithful execution, not design. All design decisions are already made
in `docs/taskito-fixes-plan/`.

**Task: implement Phase <N>, specified in `docs/taskito-fixes-plan/phase-<N, zero-padded>-*.md`.**

## Step 0 — read before writing any code, in this order
1. `AGENTS.md` (repo conventions and architecture notes).
2. `docs/taskito-fixes-plan/00-overview.md` — Bence's directives are binding.
3. `docs/taskito-fixes-plan/invariants.md` — do not rename/remove anything listed there.
4. Your phase file, in full.
5. `docs/taskito-fixes-plan/STATUS.md` — which phases are already done.
6. Every file your phase file references with a `path:line` anchor. Line numbers may
   have drifted — find the named symbol by search if a line doesn't match.

## Rules
- The phase file is the spec. Implement all of it and only it: no extra features, no
  unrelated refactors, nothing from other phases.
- Backend behavior is frozen outside your phase's listed files: no model changes,
  no new URLs, no permission changes, no schema changes except what your phase file
  explicitly enumerates.
- Never rename or remove anything listed in `docs/taskito-fixes-plan/invariants.md`.
- No `any`, no `@ts-ignore`, no `@ts-expect-error`, no `console.log` in src/ (repo
  convention — keep it that way).
- No new external dependencies unless your phase file explicitly adds them.
- Existing tests: never delete/skip/weaken. Assertion updates only when the change is
  intentional and explicitly allowed by your phase file — log each in
  `docs/taskito-fixes-plan/phase-<N>-deviations.md`.
- Match the style of neighboring code. Don't touch scratch files, local databases,
  `.next*` build dirs, or `node_modules`.
- Do not run `npm install` unless your phase file requires a new dependency (it
  shouldn't). Dependencies are already installed in node_modules.
- Do not push. Do not touch main.

## Definition of done (all required)
1. Every item in your phase file's own "Definition of done" section.
2. Tests extended with the cases your phase enumerates.
3. `npm test` passes in full (baseline 89 tests; phase adds more).
4. `npx tsc --noEmit` passes.
5. `npm run build` passes.
6. Append to `docs/taskito-fixes-plan/STATUS.md`:
   `- Phase <N> — done <YYYY-MM-DD> — <total passing test count> tests`
   (the orchestrator extends this line with provenance after review — do not add
   model/variant fields yourself).
7. Commit on the current branch: message `Phase <N>: <phase title>` plus 2–4 bullets.
   Do not push.

## Final report
End with: what you built (short), the test command output summary (counts), any
deviation from the spec and why (and its deviations file), and anything that looked
broken which you were not required to fix.
