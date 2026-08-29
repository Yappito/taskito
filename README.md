# Taskito

Taskito is a self-hosted task manager for project-scoped planning, delivery, and follow-up. It combines board, list, archive, and dependency graph views with workflow controls, custom fields, comments with attachments, notifications, and an in-app AI workspace in one deployable stack.

## Feature Overview

- Built-in AI workspace with project, task, and selected-task launchers
- Multiple task views: board, list, archive, and timeline graph
- Project-scoped workflows with configurable statuses, transition rules, due-date alerts, and auto-archive settings
- Personal and project-scoped AI provider management for remote `openai-compatible` and `anthropic` backends
- Project AI policy controls for provider scope, permission ceilings/defaults, approval mode, and `Yolo mode`
- AI action proposals with approval/rejection, execution audit rows, rollback checkpoints, and rollback actions for executed changes
- AI chat history with generated titles, markdown-rendered responses, optimistic message bubbles, and persistent send preferences
- Task detail panel with editing, dependencies, comments, activity history, watchers, duplicate, and manual archive for completed work
- Comment attachments with secure file serving and inline image preview
- Project tags with colors, merge support, and filtering across views
- Custom fields per project, including ordering and required field support
- Saved filter presets and reusable task templates
- Bulk task actions for status, assignee, tags, and archive
- Project-scoped search with keyboard navigation, assignee/status context, and task key support
- Notifications with preferences, mark-all-read, and clear-all actions
- Global settings for users, projects, workflows, tags, and custom fields
- Docker Compose deployment with PostgreSQL, nginx, migrations on boot, and persistent uploads

## AI Workspace

Taskito's AI layer is built into the app rather than treated as a separate bot. The assistant works with project, task, and selected-task context and uses the same permission and actor model as the rest of the product.

### AI Capabilities

- Project-wide, task-scoped, and selected-task AI conversations
- Conversation history with generated titles for quick reuse
- Markdown-rendered assistant responses in the chat window
- Approval-first write proposals with separate proposal cards
- Optional `Yolo mode` per conversation when project policy allows automatic execution
- Compact rollbackable AI execution history

### Supported AI Actions

When the matching permissions are granted, the AI can propose and execute:

- comments
- task links
- status changes
- assignee changes
- task edits for core fields, tags, and custom fields
- bulk updates on selected tasks only
- task creation
- task duplication
- archive and unarchive

### Provider Model

- Remote providers only
- Supported adapters:
  - `openai_compatible`
  - `anthropic`
- Providers can be configured per user or per project
- Providers can be tested from the UI before use

### Safety Model

- AI provider calls are server-side only
- Provider secrets are encrypted before persistence
- Writes default to approval mode
- `Yolo mode` is explicit and project-policy-gated
- Executed AI changes run as the current signed-in user
- Executed AI changes are checkpointed so they can be rolled back

Detailed implementation notes and the full summary of features added since the last commit are in [FEATURES_SINCE_LAST_COMMIT.md](FEATURES_SINCE_LAST_COMMIT.md).

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 App Router |
| Language | TypeScript |
| API | tRPC + App Router endpoints |
| Database | PostgreSQL 16 + Prisma 6 |
| Auth | Auth.js credentials |
| UI | React 19 + Tailwind CSS 4 |
| AI integrations | OpenAI-compatible APIs + Anthropic |
| Graph layout | ELK.js + D3.js |
| Deployment | Docker Compose |

## Prerequisites

- Docker Desktop or Docker Engine with Compose

For deployment, Docker is enough. The published app image includes the Prisma and tsx tooling plus the bundled bootstrap and seed scripts, so those can be run inside the container after the stack is up.

Node.js 22+ and npm are only needed if you want to work from a repository checkout for local development, tests, or direct script execution outside Docker.

## Deployment

This repository now uses a single Docker Compose path based on [docker-compose.yml](docker-compose.yml).

### 1. Clone the repository

```bash
git clone https://github.com/Yappito/taskito.git
cd taskito
```

### 2. Create the deployment env file

```bash
cp .env.example .env
```

Set real values for:

- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`
- `AUTH_URL`
- `AUTH_SECRET`

Optional values:

- `AUTO_TAGGER_URL`
- `AUTO_TAGGER_API_KEY`
- `AI_SECRET_MASTER_KEY`
- `AI_PROVIDER_HOST_ALLOWLIST`
- `AI_PROVIDER_ALLOW_PRIVATE_HOSTS`
- `AI_PROVIDER_REQUEST_TIMEOUT_MS`
- `ALLOW_DEMO_SEED`

`DATABASE_URL` and `AUTH_TRUST_HOST` are injected by the compose file.

If you plan to use AI providers, set `AI_SECRET_MASTER_KEY` explicitly to a base64-encoded 32-byte value instead of relying on any implicit fallback behavior.

### 3. Start the stack

```bash
docker compose up -d --pull always
```

This starts:

- `app` for the Next.js server
- `postgres` for the database
- `nginx` on port `80`

The application container runs `prisma migrate deploy` automatically before starting the server.

### 4. Create the first admin account

If you want a clean production instance without demo data, bootstrap an admin user:

```bash
docker compose exec \
  -e BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
  -e BOOTSTRAP_ADMIN_NAME="Initial Admin" \
  app npm run db:bootstrap-admin
```

Optional:

- Add `-e BOOTSTRAP_ADMIN_PASSWORD="strong-password"` to choose the password explicitly.
- If you omit the password, the script generates one and prints it once.

### 5. Seed demo data only if you want sample content

```bash
docker compose exec \
  -e ALLOW_DEMO_SEED=true \
  app npm run db:seed
```

Only do this when you want the sample project, tasks, and demo login. The seed script refuses to run in production unless `ALLOW_DEMO_SEED=true` is present in the container environment.

The seeded demo admin account uses `admin@taskito.local` and defaults to `taskito-demo-2026`. Override it with `DEMO_ADMIN_PASSWORD` when you want a different demo credential.

You can use the same pattern for other bundled maintenance commands once the app container is running:

```bash
docker compose exec app npm run db:generate
docker compose exec app ./node_modules/.bin/prisma migrate deploy
```

### Optional AI setup in the app

After the stack is running and you can sign in:

1. Add a personal provider in `Settings -> AI`, or a shared provider in `Project -> AI`.
2. Test the provider from the UI.
3. Set the project AI policy for default permissions, maximum permissions, provider scope, and `Yolo mode`.
4. Launch AI from the project page, a task detail view, or a selected-task view in board/list mode.

### 6. Check the running stack

```bash
docker compose ps
docker compose logs -f app
```

## Persistence

The compose stack persists two things by default:

- PostgreSQL data in the `pgdata` volume
- Comment attachments and profile images in the `uploads` volume mounted at `/app/uploads`

That means uploaded files survive container rebuilds and restarts as long as the Docker volume remains intact.

### Optional S3-compatible storage

Uploads can also be stored in S3-compatible object storage instead of the local Docker volume. Set `STORAGE_PROVIDER=s3` and the `STORAGE_S3_*` variables in compose, or configure the same values as an admin in `Settings -> Storage`. UI-saved storage settings override environment variables; clear the UI override to return to compose/env settings.

Task comment attachments and profile images are still served through authenticated Taskito routes. Each stored file records its storage backend, bucket, and object key in the database, so restoring the database and reconnecting the same S3 bucket restores access to S3-backed files.

## Notifications

Notifications are fan-out per recipient through a single dispatcher (`src/server/services/notifications.ts`). Every notification creates the in-app row it always did and, independently, may send an email through the optional SMTP channel. Email delivery is fire-and-forget: it can never block or fail the originating mutation, errors are logged (never credentials), and sends flow through a small in-process queue that caps at 100 pending jobs and drops beyond that with a warning.

### Channels and per-type preferences

Each of the four notification types (`assigned`, `commented`, `statusChanged`, `mentioned`) has two independent switches stored in `User.settings`:

- `notificationPreferences` — the existing in-app switches (default ON).
- `emailChannel` — the channel switches (default OFF for everything except `mentioned` and `assigned`, which default ON).

Both are editable in the notification bell's Preferences block, which shows "In-app" and "Email" checkbox columns, and they are exposed for read/update via the notification router (`notification.preferences` / `notification.updatePreferences`) and the user router (`user.notificationPreferences` / `user.updateNotificationPreferences`).

### Enabling email

Email sending activates when `SMTP_HOST` and `SMTP_FROM` are set (all `SMTP_*` variables are listed in the environment table). Without configuration, sending is a logged no-op and every channel switch is harmless. Emails carry a text/plain and text/html body and deep links of the form `{AUTH_URL}/{project.slug}?task={taskId}`, which opens the task directly in a project view.

Credentials are never sent over an unencrypted connection: unless the link is already TLS (`SMTP_SECURE=true`) or the server advertises STARTTLS (which the client always upgrades first), SMTP authentication is refused with a clear error instead of transmitting the password in plaintext. Only set `SMTP_ALLOW_INSECURE_AUTH=true` for trusted, isolated networks (e.g. a local relay you fully control).

### Daily due-soon digest

Users can opt in to a daily due-soon digest with the "Daily due-soon digest (email)" preference (stored in `emailChannel.digest`, default OFF). The digest groups, across all of the user's accessible projects:

- overdue open tasks (due before today),
- tasks due today,
- tasks due within the project's `dueDateWarningDays` setting (see `src/lib/alert-utils.ts`),
- open tasks assigned to the user that are blocked by an unfinished task (`blocks` task links).

Users with nothing to report are skipped. `runDailyDigestJob()` in `src/server/services/email/digest.ts` is the scheduler-facing entry point, and the built-in scheduler runs it once the current UTC hour reaches `SCHEDULER_DIGEST_HOUR_UTC` (default 7; see the Scheduling section).

Double-send protection is layered: a per-process once-per-UTC-day fast path, plus a database-backed guard — after a digest is sent, `emailChannel.lastDigestSentAt` (ISO string) is written to the recipient's `User.settings`, and users whose `lastDigestSentAt` already falls within the current UTC day are skipped. That way a restart, failover, or a second replica never resends a digest for the same UTC day.
## Scheduling

Three features are time-driven and need a scheduler: recurring tasks (the next occurrence is created automatically), automation rules with the `dueDatePassed` trigger, and the daily due-soon digest email. All three can run through two interchangeable paths:

### Built-in in-process scheduler (default)

The production container runs a small in-process scheduler via Next.js instrumentation (`src/instrumentation.ts`). On every tick it:

1. Opens an interactive transaction and takes a transaction-scoped Postgres advisory lock (`pg_try_advisory_xact_lock`, `src/server/services/scheduler.ts`) inside it, so in multi-replica deployments only one instance actually runs jobs — the others skip the tick. The lock lives on the transaction's own connection and is released automatically at commit/rollback, so it cannot leak on a pool connection.
2. Processes due recurrence rules (creates the next recurring tasks).
3. Runs `dueDatePassed` automation rules for every project that has them enabled. Actions are attributed to the project owner (the `owner`-role project member), since automation rules do not store a creator.
4. Sends the daily due-soon digest (see Notifications) once the current UTC hour reaches `SCHEDULER_DIGEST_HOUR_UTC`. Per-user bookkeeping in `User.settings` (`emailChannel.lastDigestSentAt`) prevents restarts or other replicas from double-sending.

Failures are logged with a `[scheduler]` prefix (without secrets) and never abort the remaining jobs. The scheduler is enabled by default and can be configured with:

| Variable | Default | Notes |
|---|---|---|
| `SCHEDULER_ENABLED` | `true` | Set to `false` to disable the built-in scheduler (e.g. when you prefer an external cron) |
| `SCHEDULER_INTERVAL_MS` | `60000` | Tick interval in milliseconds; values below `1000` are clamped to `1000` |
| `SCHEDULER_TICK_TIMEOUT_MS` | `600000` | Maximum duration of one tick; the tick's advisory-lock transaction is aborted when exceeded |
| `SCHEDULER_DIGEST_HOUR_UTC` | `7` | Earliest UTC hour at which the daily due-soon digest may run (invalid values fall back to the default) |

The scheduler runs inside the web process, so no extra container or worker is needed. It only starts in the Node.js runtime on server boot — never during `next build`.

### External cron (optional)

If you prefer your own scheduler (system crontab, Kubernetes CronJob, etc.), set `SCHEDULER_ENABLED=false` and schedule a POST against the cron endpoint:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-taskito-host/api/cron/process-recurring
```

| Variable | Notes |
|---|---|
| `CRON_SECRET` | Bearer token for the cron endpoint. With it unset the endpoint answers `503`; with a wrong token `401` |

Both task recurrence and due-date automation can also be triggered manually from Project settings → Automation ("Process due-date rules") and from the recurring-task controls. The external cron endpoint does not trigger the daily digest — that one is owned by the built-in scheduler.

Prefer running exactly one path: leave the built-in scheduler on and skip the cron job, or disable the built-in scheduler with `SCHEDULER_ENABLED=false` and drive jobs externally.

## API access

Personal API tokens let scripts, external tools (and, later, MCP clients) call Taskito's tRPC API and the task/comment JSON routes as you, without an interactive browser session.

Create a token under **Settings → Profile → API tokens**. The plaintext token (`tk_<32 random bytes, base64url>`) is shown exactly once at creation and only an argon2id hash plus a short lookup prefix are stored. Requests authenticate with a bearer header:

```bash
curl -s http://localhost:3000/api/trpc/user.me \
  -H "Authorization: Bearer tk_YOUR-TOKEN-HERE"
```

This targets the tRPC endpoint (`/api/trpc/...`, superjson-encoded responses) and works the same against the JSON routes under `/api/tasks/**` and `/api/comment-attachments/**`.

Notes:

- Tokens are personal: requests act as the owning user, and the role is always re-read from the user record (a disabled user's tokens stop working immediately).
- `scopes` is reserved for future fine-grained permissions; v1 creates every token with the `["*"]` wildcard scope only.
- Tokens never grant admin. v1 decision: token-authenticated requests can call any non-admin API as the user, but every `adminProcedure` — including for admin users — plus `user.changePassword`, `user.updateProfile`, the global-admin checks (e.g. shared AI provider management), and the token management procedures themselves (`user.createApiToken`, `user.listApiTokens`, `user.revokeApiToken`) are rejected and require an interactive browser session. Tokens also cannot be used to change your password or email, and are not accepted by `/api/auth/*` (NextAuth) endpoints.
- Token requests may not list or modify other users; failed bearer attempts are rate limited per client IP.

## Operations

Useful commands from the repository root:

| Command | Purpose |
|---|---|
| `docker compose up -d --pull always` | Pull the latest image and start the full stack |
| `docker compose ps` | Check container status |
| `docker compose logs -f app` | Tail application logs |
| `docker compose logs -f nginx` | Tail reverse proxy logs |
| `docker compose exec app npm run db:bootstrap-admin` | Bootstrap or reset an admin user from inside the running container |
| `docker compose exec app npm run db:seed` | Seed demo data from inside the running container |
| `docker compose exec app npm run db:generate` | Rebuild the Prisma client inside the running container |
| `docker compose exec app ./node_modules/.bin/prisma migrate deploy` | Re-run migrations manually |
| `docker compose down` | Stop the stack |
| `docker compose down -v` | Stop the stack and remove persisted volumes |

## Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `POSTGRES_USER` | Yes | PostgreSQL user for the compose stack |
| `POSTGRES_PASSWORD` | Yes | PostgreSQL password for the compose stack |
| `POSTGRES_DB` | Yes | PostgreSQL database name |
| `AUTH_URL` | Yes | Public base URL of the app |
| `AUTH_SECRET` | Yes | Auth.js signing secret |
| `OIDC_ISSUER` | No | Generic OIDC issuer URL for single-provider SSO |
| `OIDC_CLIENT_ID` | No | OIDC client ID |
| `OIDC_CLIENT_SECRET` | No | OIDC client secret |
| `OIDC_PROVIDER_ID` | No | Stable provider id; defaults to `oidc` |
| `OIDC_PROVIDER_NAME` | No | Login button label; defaults to `OIDC` |
| `OIDC_GROUPS_CLAIM` | No | Claim path used to sync groups; defaults to `groups` |
| `OIDC_ALLOW_SIGNUP` | No | Allow first-time OIDC users; defaults to `true` |
| `OIDC_ALLOW_EMAIL_ACCOUNT_LINKING` | No | Link OIDC accounts to existing users by email; defaults to `false` |
| `OIDC_ADMIN_EMAILS` | No | Comma-separated OIDC emails promoted to global admin |
| `OIDC_PROVIDERS` | No | JSON array for multiple OIDC providers; supports `id`, `name`, `issuer`, `clientId`, `clientSecret` or `clientSecretEnv`, `scope`, `groupsClaim`, `defaultRole`, `allowSignup`, `allowEmailAccountLinking`, `requireEmailVerified`, and `adminEmails` |
| `ALLOW_DEMO_SEED` | No | Leave `false` unless you intentionally want demo data |
| `DEMO_ADMIN_PASSWORD` | No | Optional password for the seeded demo admin account |
| `AUTO_TAGGER_URL` | No | Optional OpenAI-compatible tagging endpoint |
| `AUTO_TAGGER_API_KEY` | No | Optional API key for the auto-tagger |
| `AI_SECRET_MASTER_KEY` | Recommended for AI | Base64-encoded 32-byte key used to encrypt AI provider secrets and S3/OIDC secrets at rest. Strongly recommended in production; when unset in production the app refuses to encrypt/decrypt stored secrets unless `AI_ALLOW_AUTH_SECRET_FALLBACK=true` |
| `AI_ALLOW_AUTH_SECRET_FALLBACK` | No | Set `true` to explicitly allow deriving the secret encryption key from `AUTH_SECRET` when `AI_SECRET_MASTER_KEY` is unset (production only; not recommended — see rotation notes below) |
| `AI_PROVIDER_HOST_ALLOWLIST` | No | Optional comma-separated allowlist for AI provider endpoints. Entries are `host` or `host:port` (IPv6 literals bracketed). Public hosts may use a bare `host` entry (any port); private/loopback hosts require an exact `host:port` entry (e.g. `localhost:11434`) or the global `AI_PROVIDER_ALLOW_PRIVATE_HOSTS=true` override, so an entry can never open every TCP port on a host |
| `AI_PROVIDER_ALLOW_PRIVATE_HOSTS` | No | Set `true` only to allow AI provider base URLs that point at loopback/private/link-local addresses (self-hosted Ollama, LM Studio, etc.); defaults to `false`, which rejects any provider host that is or resolves to a private address |
| `AI_PROVIDER_REQUEST_TIMEOUT_MS` | No | Optional upstream AI provider request timeout in milliseconds; defaults to `90000` |
| `REENCRYPT_TX_TIMEOUT_MS` | No | Interactive-transaction timeout (ms) for the `db:reencrypt-ai-secrets` rotation script; defaults to `300000` because three table scans plus per-row updates can exceed the Prisma 5s default. Run the rotation in a maintenance window: the transaction holds an advisory lock and aborts if row counts change mid-run |
| `STORAGE_PROVIDER` | No | `local` or `s3`; defaults to `local` |
| `STORAGE_S3_BUCKET` | Required for S3 | Bucket used for attachments and profile images |
| `STORAGE_S3_REGION` | No | S3 region; defaults to `us-east-1` |
| `STORAGE_S3_ENDPOINT` | No | Optional S3-compatible endpoint for MinIO, R2, etc. |
| `STORAGE_S3_ACCESS_KEY_ID` | No | S3 access key ID; leave unset to use default AWS credentials/IAM role |
| `STORAGE_S3_SECRET_ACCESS_KEY` | No | S3 secret access key; required when `STORAGE_S3_ACCESS_KEY_ID` is set |
| `STORAGE_S3_SESSION_TOKEN` | No | Optional temporary credentials session token |
| `STORAGE_S3_FORCE_PATH_STYLE` | No | Set `true` for S3-compatible services that need path-style URLs |
| `STORAGE_S3_PREFIX` | No | Optional object key prefix, e.g. `taskito/prod` |
| `SMTP_HOST` | Required for email | SMTP server hostname; together with `SMTP_FROM` this enables the email channel |
| `SMTP_PORT` | No | SMTP port; defaults to `587` |
| `SMTP_SECURE` | No | `true` = implicit TLS (typically port `465`); defaults to `false`, using STARTTLS when the server offers it |
| `SMTP_USER` | Required with auth | SMTP username; omit for unauthenticated relays |
| `SMTP_PASSWORD` | Required with auth | SMTP password; never sent over plaintext — with `SMTP_USER`/`SMTP_PASSWORD` the client requires TLS (implicit or via STARTTLS) unless `SMTP_ALLOW_INSECURE_AUTH=true` |
| `SMTP_FROM` | Required for email | Envelope/From address, e.g. `Taskito <noreply@example.com>`; required to enable sending |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | No | Set `false` only for self-signed certificates; defaults to `true` |
| `SMTP_ALLOW_INSECURE_AUTH` | No | Must be exactly `true` to allow SMTP AUTH over a connection without TLS; defaults to `false` (refuse instead of leaking credentials) |
| `SCHEDULER_ENABLED` | No | In-process scheduler for recurrences + due-date automation; defaults to `true` — set `false` to rely only on the external cron endpoint |
| `SCHEDULER_INTERVAL_MS` | No | Scheduler tick interval in milliseconds; defaults to `60000` (values below 1000 clamp to 1000) |
| `SCHEDULER_DIGEST_HOUR_UTC` | No | Earliest UTC hour for the daily due-soon digest email; defaults to `7` (0–23) |
| `CRON_SECRET` | No | Bearer token for `POST /api/cron/process-recurring`; unset keeps that endpoint disabled (503) |

### Rotating the secret encryption key (`AI_SECRET_MASTER_KEY`)

Stored AI provider secrets, OIDC client secrets, and S3 storage credentials are encrypted at rest. New ciphertext is written as `v1:<payload>`; legacy unprefixed ciphertext keeps decrypting. Rotating `AUTH_SECRET` no longer silently breaks those secrets if a dedicated master key is configured — and if it ever does, the re-encryption script restores access:

1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. Pick a maintenance window and **stop the app (or make AI/provider and storage settings temporarily read-only) for the duration of the rotation**. The re-encryption script re-counts sensitive rows inside a locked transaction and aborts if rows were added or removed mid-run, but a fully idle deployment is the only way to also rule out in-place secret changes during the run.
3. Dry run (always start here):
   `AI_SECRET_MASTER_KEY=<new key> AI_SECRET_MASTER_KEY_OLD=<old master key> npm run db:reencrypt-ai-secrets -- --dry-run`
   Omit `AI_SECRET_MASTER_KEY_OLD` when the old ciphertext was produced by the legacy `sha256(AUTH_SECRET)` fallback (keep `AUTH_SECRET` set so the old key can be derived).
4. Apply: run the same command again without `--dry-run`. The script re-encrypts in a single transaction (holding a Postgres advisory lock) and prints per-table counts; it aborts with nothing committed if any row fails to decrypt or row counts change during the run.
5. Re-check: run the same command once more (no `--dry-run`). It should report every row as "already current" with zero re-encryptions — that confirms the first pass caught everything and that nothing was written under the old key afterwards.
6. Update the deployment environment to `AI_SECRET_MASTER_KEY=<new key>` and restart. Only then (optionally) rotate `AUTH_SECRET`.

If a run fails with a transaction timeout (very large tables), raise the interactive-transaction budget with `REENCRYPT_TX_TIMEOUT_MS=<milliseconds>` (default `300000`).

If you previously ran without a master key (e.g. compose deployments before this variable was forwarded), migrate from the auth-secret fallback with `AI_SECRET_MASTER_KEY=<new key> AUTH_SECRET=<unchanged> npm run db:reencrypt-ai-secrets`.

## Notes

- Attachment uploads are tied to task comments, not stored as standalone task files.
- Attachment downloads go through authenticated project access checks.
- Profile images also go through authenticated routes and use the same local/S3 storage backend as attachments.
- Access is RBAC-based: global admins manage users and groups, project roles grant permissions, and OIDC group claims can populate managed groups automatically.
- OIDC providers can be managed in `Settings -> Auth`. Client secrets entered there are encrypted at rest and write-only: they are never returned by the settings API after saving. Environment-configured OIDC providers remain supported and appear read-only in that screen.
- The app image creates `/app/uploads` automatically and the compose stack mounts it to a persistent Docker volume for local storage.
- nginx is configured to accept request bodies large enough for the application attachment limit.
- The GitHub Actions workflow in `.github/workflows/build-container.yml` publishes `latest` from `main`, version tags from Git tags such as `v1.0.0`, and a commit SHA tag for traceability.
- The documented `docker compose up -d --pull always` command refreshes the published app image before startup.
- AI provider URLs are validated before use and can be restricted further with `AI_PROVIDER_HOST_ALLOWLIST` (`host` or `host:port` entries; private/loopback hosts need an exact `host:port` entry).
- By default, AI provider base URLs must not point at loopback, private, or link-local addresses — including hostnames that resolve to them. Egress to private targets is re-checked on every upstream request. Self-hosted endpoints (e.g. Ollama, LM Studio) require opting in via `AI_PROVIDER_ALLOW_PRIVATE_HOSTS=true` or by adding the host to `AI_PROVIDER_HOST_ALLOWLIST`.
- Provider responses are never fetched with Node's default redirect-following: every redirect hop is re-validated against the same policy (allowlist, private/resolved-address checks) before it is requested, at most 3 redirects are followed, credential headers are stripped when a redirect crosses origins, and 301/302/303 never replay the request body (only 307/308 keep the original method and body). Redirects to disallowed targets are rejected outright.
- AI-generated writes are permission-scoped and approval-based unless `Yolo mode` is explicitly enabled for the conversation and allowed by project policy.

## Development

If you want to run the Next.js dev server outside Docker, you can still use the repository locally with Node.js and a PostgreSQL instance. The simplified repository deployment path, however, is the Compose stack above.

## License

[MIT](LICENSE)
