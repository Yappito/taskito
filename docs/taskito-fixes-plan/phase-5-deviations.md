# Phase 5 Deviations

## Postgres hardening skipped (C6) — verified boot failure

Spec (T5.3): "Postgres: consider `cap_drop: [ALL]` + `security_opt` as well (if
it boots — verify)."

It does not boot. Verified with the official `postgres:16-alpine` image under
`cap_drop: [ALL]` + `no-new-privileges`:

- Entrypoint fails at privilege drop and init: `error: failed switching to
  'postgres': operation not permitted` (gosu needs CAP_SETUID/CAP_SETGID) and
  `chmod/chown: Operation not permitted` (init needs CHOWN/FOWNER).
- Same failure reproduced in the full compose stack (`taskito-postgres-1` never
  became healthy).

Per the spec's condition, postgres is left unchanged (default caps, existing
healthcheck + restart policy). `app` and `nginx` hardening is in place and was
boot-tested.

## nginx needs three cap_adds alongside cap_drop: [ALL]

Spec (T5.3): "nginx: same cap_drop + no-new-privileges". Empirically,
`nginx:alpine` with `cap_drop: [ALL]` alone fails at startup
(`chown("/var/cache/nginx/client_temp") ... Operation not permitted`). The
compose file therefore adds the minimal capability set required to boot:

- `NET_BIND_SERVICE` — bind port 80.
- `SETUID` / `SETGID` — master drops privileges to the `nginx` worker user.
- `CHOWN` — entrypoint/startup chowns `/var/cache/nginx/*_temp`.

Verified: hardened nginx container serves HTTP 200, and `nginx -t` on the
repo's `nginx.conf` (with `app` host resolved) reports syntax ok.

## AUTH_URL validation fires on first request, not at process start

Spec (T5.2): "Production boot fails without a valid https `AUTH_URL`". The
`throw` lives in the `isProductionRuntime` block of `src/lib/auth.ts`, which is
evaluated when the auth module is first imported. Next.js standalone mode
lazy-loads route modules, so the server process starts and then fails once a
request hits a route that imports `@/lib/auth` (any `/api/trpc/*`, `/api/auth/*`,
task/comment/attachment/ai-stream routes). Verified: with
`AUTH_URL=http://...` the container starts but every tRPC request returns 500
(`AUTH_URL must be set to a valid absolute https URL in production`), so in
compose the healthcheck never passes and the app is never functional/healthy.

This is the pre-existing behavior of the AUTH_SECRET check in the same block
(identical lazy pattern) and the spec's own wording is "throw if missing or
invalid" — implemented as specified, with the timing nuance recorded here.

## Compose migrate choice: app command override

Spec (T5.3) allowed either overriding `command` in compose or keeping the
Dockerfile CMD idempotent. Chosen: compose `app` runs `command: ["node",
"server.js"]`; the Dockerfile CMD keeps `prisma migrate deploy && node
server.js` for non-compose users. Documented in README. Verified in the smoke
test: `migrate` applied all migrations and exited 0 before `app` started.

## Test changes

- No existing test was deleted, skipped, or weakened; no existing assertions
  were changed. Phase 5 enumerates no new test cases and its scope boundary
  (invariants.md) lists no test files; verification is covered by the full
  suite (`npm test`: 126 passing) plus the docker smoke test described above.
