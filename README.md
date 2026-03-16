# Taskito

Taskito is a self-hosted task manager for project-scoped planning, delivery, and follow-up. It combines board, list, archive, and dependency graph views with workflow controls, custom fields, comments with attachments, notifications, and operational tooling in one deployable stack.

## Feature Overview

- Multiple task views: board, list, archive, and timeline graph
- Project-scoped workflows with configurable statuses, transition rules, due-date alerts, and auto-archive settings
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

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 App Router |
| Language | TypeScript |
| API | tRPC + App Router endpoints |
| Database | PostgreSQL 16 + Prisma 6 |
| Auth | Auth.js credentials |
| UI | React 19 + Tailwind CSS 4 |
| Graph layout | ELK.js + D3.js |
| Deployment | Docker Compose |

## Prerequisites

- Docker Desktop or Docker Engine with Compose
- Node.js 22+
- npm

Node.js is required to build the image from the repository checkout and to run supporting scripts such as admin bootstrap, Prisma utilities, and tests. The deployed application itself runs inside Docker.

## Deployment

This repository now uses a single Docker Compose path based on [docker-compose.yml](docker-compose.yml).

### 1. Create the deployment env file

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
- `ALLOW_DEMO_SEED`

`DATABASE_URL` and `AUTH_TRUST_HOST` are injected by the compose file.

### 2. Build and start the stack

```bash
docker compose up -d --build
```

This starts:

- `app` for the Next.js server
- `postgres` for the database
- `nginx` on port `80`

The application container runs `prisma migrate deploy` automatically before starting the server.

### 3. Create the first admin account

If you want a clean production instance without demo data, bootstrap an admin user:

```bash
docker compose exec \
  -e BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
  -e BOOTSTRAP_ADMIN_NAME="Initial Admin" \
  app ./node_modules/.bin/tsx prisma/bootstrap-admin.ts
```

Optional:

- Add `-e BOOTSTRAP_ADMIN_PASSWORD="strong-password"` to choose the password explicitly.
- If you omit the password, the script generates one and prints it once.

### 4. Seed demo data only if you want sample content

```bash
docker compose exec \
  -e ALLOW_DEMO_SEED=true \
  app ./node_modules/.bin/tsx prisma/seed.ts
```

Only do this when you want the sample project, tasks, and demo login. The seed script refuses to run in production unless `ALLOW_DEMO_SEED=true` is present in the container environment.

### 5. Check the running stack

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
| `docker compose up -d --build` | Build and start the full stack |
| `docker compose ps` | Check container status |
| `docker compose logs -f app` | Tail application logs |
| `docker compose logs -f nginx` | Tail reverse proxy logs |
| `docker compose exec app ./node_modules/.bin/prisma migrate deploy` | Re-run migrations manually |
| `docker compose exec app ./node_modules/.bin/tsx prisma/bootstrap-admin.ts` | Bootstrap or reset an admin user |
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
| `AUTO_TAGGER_URL` | No | Optional OpenAI-compatible tagging endpoint |
| `AUTO_TAGGER_API_KEY` | No | Optional API key for the auto-tagger |

## Notes

- Attachment uploads are tied to task comments, not stored as standalone task files.
- Attachment downloads go through authenticated project access checks.
- The app image creates `/app/uploads` automatically and the compose stack mounts it to a persistent Docker volume.
- nginx is configured to accept request bodies large enough for the application attachment limit.

## Development

If you want to run the Next.js dev server outside Docker, you can still use the repository locally with Node.js and a PostgreSQL instance. The simplified repository deployment path, however, is the Compose stack above.

## License

[MIT](LICENSE)
