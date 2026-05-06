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

The compose stack persists two things:

- PostgreSQL data in the `pgdata` volume
- Comment attachments in the `uploads` volume mounted at `/app/uploads`

That means uploaded files survive container rebuilds and restarts as long as the Docker volume remains intact.

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
| `ALLOW_DEMO_SEED` | No | Leave `false` unless you intentionally want demo data |
| `DEMO_ADMIN_PASSWORD` | No | Optional password for the seeded demo admin account |
| `AUTO_TAGGER_URL` | No | Optional OpenAI-compatible tagging endpoint |
| `AUTO_TAGGER_API_KEY` | No | Optional API key for the auto-tagger |
| `AI_SECRET_MASTER_KEY` | Recommended for AI | Base64-encoded 32-byte key used to encrypt stored AI provider secrets |
| `AI_PROVIDER_HOST_ALLOWLIST` | No | Optional comma-separated host allowlist for AI provider endpoints |
| `AI_PROVIDER_REQUEST_TIMEOUT_MS` | No | Optional upstream AI provider request timeout in milliseconds; defaults to `90000` |

## Notes

- Attachment uploads are tied to task comments, not stored as standalone task files.
- Attachment downloads go through authenticated project access checks.
- The app image creates `/app/uploads` automatically and the compose stack mounts it to a persistent Docker volume.
- nginx is configured to accept request bodies large enough for the application attachment limit.
- The GitHub Actions workflow in `.github/workflows/build-container.yml` publishes `latest` from `main`, version tags from Git tags such as `v1.0.0`, and a commit SHA tag for traceability.
- The documented `docker compose up -d --pull always` command refreshes the published app image before startup.
- AI provider URLs are validated before use and can be restricted further with `AI_PROVIDER_HOST_ALLOWLIST`.
- AI providers may use either `http://` or `https://`, including local or private-network endpoints for self-hosted LLMs.
- AI-generated writes are permission-scoped and approval-based unless `Yolo mode` is explicitly enabled for the conversation and allowed by project policy.

## Development

If you want to run the Next.js dev server outside Docker, you can still use the repository locally with Node.js and a PostgreSQL instance. The simplified repository deployment path, however, is the Compose stack above.

## License

[MIT](LICENSE)
