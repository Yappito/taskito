# Phase 5: Config, deployment, CI

## Context

Criticals C1/C2/C3 and highs C4/C5/C6/C9 from `docs/taskito-fixes-plan/00-overview.md`.
Bence directive 4: Caddy reverse proxy terminates TLS in front of the app container —
fix the app to behave correctly behind it, don't add TLS inside the container.

## Scope (files you may touch)

- `nginx.conf`
- `docker-compose.yml`
- `Dockerfile` (only if the migrate step must move — prefer compose-level change)
- `src/lib/auth.ts` (production AUTH_URL / trustHost validation)
- `src/middleware.ts` (only if cookie/proto handling needs alignment)
- `.env.example`
- `README.md` (Caddy/TLS documentation section)
- New: `.github/workflows/ci.yml`
- `docs/taskito-fixes-plan/STATUS.md`

## Tasks

### T5.1 — CSP: no unsafe-eval in production
In `nginx.conf` (line 12): remove `'unsafe-eval'` from `script-src`. Keep
`'unsafe-inline'` if needed for Next.js inline scripts (verify: Next.js prod builds
emit external scripts; `unsafe-inline` is often still needed for inline bootstrap —
keep it, remove only `'unsafe-eval'`). The result must match the `next.config.ts`
production CSP (which already excludes unsafe-eval).

### T5.2 — Production auth behind TLS proxy
In `src/lib/auth.ts`:
- In production (`isProductionRuntime` block, line 18): additionally require
  `process.env.AUTH_URL` to be set and parseable as an absolute URL with `https:` —
  throw if missing/invalid. (Caddy terminates TLS, so the public URL is https even
  though the app serves http internally.)
- `trustHost` (line 176): currently `process.env.AUTH_TRUST_HOST === "true"`. Make it:
  `true` when `AUTH_URL` is set OR when `AUTH_TRUST_HOST === "true"` (keep backward
  compat with compose which sets `AUTH_TRUST_HOST=true`), and document that
  production deployments behind a proxy must set `AUTH_URL`.
- Ensure session cookie `secure` flag is correct behind the proxy: middleware.ts
  already derives `isSecureRequest` from `x-forwarded-proto` (line 4-11) — verify
  `getToken`/NextAuth cookie config use the same determination; align if the auth
  config hardcodes `useSecureCookies` anywhere.
- Do NOT add TLS termination inside the app container.

### T5.3 — Compose: migrate as one-shot, container hardening
In `docker-compose.yml`:
- Add a `migrate` one-shot service (same `app` image) that runs
  `./node_modules/.bin/prisma migrate deploy` (or the Dockerfile CMD's migrate part),
  `depends_on: postgres (healthy)`, `restart: "no"`.
- `app` service: `depends_on: { migrate: { condition: service_completed_successfully }, postgres: { condition: service_healthy } }`.
- Remove the migrate step from the app's runtime command (Dockerfile CMD can stay for
  non-compose users, but in compose override `command: ["node", "server.js"]` or keep
  the CMD idempotent — choose the cleaner option and document it).
- Hardening: add to `app` service:
  - `read_only: true` if the app can run read-only (uploads volume is writable;
    check if Next standalone needs /tmp — add `tmpfs: [/tmp]` if needed).
  - `cap_drop: [ALL]`.
  - `security_opt: [no-new-privileges:true]`.
  - `mem_limit` / `pids_limit` sane values (e.g. mem_limit 2g, pids_limit 256) — match
    the app's needs; keep nginx/postgres unchanged or lightly hardened (nginx: same
    cap_drop + no-new-privileges).
  - If `read_only: true` breaks the build/runtime, document the deviation in
    phase-05-deviations.md and keep cap_drop + no-new-privileges.
- Postgres: consider `cap_drop: [ALL]` + `security_opt` as well (if it boots — verify).
- Healthcheck for `app` stays.

### T5.4 — .env.example secrets
In `.env.example`:
- Replace `AUTH_SECRET="replace-with-a-cryptographically-strong-secret"` with a
  generated random value comment + placeholder (e.g. generate one now with openssl
  rand -base64 32 and put a real-looking example + comment that it MUST be changed).
  Keep the file's existing style.
- `AI_SECRET_MASTER_KEY=""` → comment noting it is REQUIRED in production (no fallback
  since Phase 1), and show the `openssl rand -base64 32` generation command.
- `CRON_SECRET` — add an example entry (the cron endpoint requires it; currently
  absent from .env.example — add `CRON_SECRET=""` with comment).
- `OIDC_*` vars: if present in code but absent here, add commented placeholders
  (check `src/server/services/oidc-provider-settings.ts` for names — add only if
  quickly verifiable, otherwise note in deviations).

### T5.5 — CI workflow
New `.github/workflows/ci.yml`:
- Triggers: `pull_request` to `main`, `push` to `main`.
- Jobs: one `ci` job on `ubuntu-latest`:
  - checkout, setup-node 22, `npm ci`.
  - `npx prisma generate` (postinstall does it, but be explicit).
  - `npm run lint` (or `npx eslint .`), `npx tsc --noEmit`, `npm test`, `npm run build`.
- Keep it simple and fast; no Docker build in CI (that's the existing
  build-container.yml's job).

### T5.6 — README: Caddy/TLS documentation
In `README.md` add a short "Reverse proxy / TLS" section:
- Recommended: Caddy in front of the app container; Caddyfile snippet with
  `reverse_proxy app:3000`, automatic HTTPS, and note to set `AUTH_URL=https://your-domain`.
- Note: `AUTH_TRUST_HOST=true` (compose) works with this setup.
- Note HSTS: Caddy sends HSTS automatically with automatic HTTPS.
- Note forwarded headers: Caddy sets X-Forwarded-* automatically.

## Definition of done

1. `nginx.conf` prod CSP has no `unsafe-eval`.
2. Production boot fails without a valid https `AUTH_URL`; trustHost derived correctly.
3. `docker compose config` validates; migrate is a one-shot; hardening flags present.
4. `.env.example` documents strong secrets, master key requirement, CRON_SECRET.
5. `.github/workflows/ci.yml` runs lint + tsc + test + build on PR/push.
6. README documents Caddy/TLS.
7. `npm test` (all), `npx tsc --noEmit`, `npm run build` all pass.
8. If docker is available on the host, `docker compose config` output verified by the
   orchestrator after the phase.
