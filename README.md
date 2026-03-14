# Taskito

Taskito is a self-hosted task manager built around a timeline-graph view. It combines kanban, list, archive, and dependency graph workflows in a single project-scoped app, with fast task creation, search, and customizable workflows.

## What It Does

- Project switcher in the main toolbar, with every view scoped to the selected project.
- Board view with drag-and-drop status changes, plus title and tag filters.
- List view with sorting, title filtering, and tag filtering.
- Graph view with timeline zoom levels, dependency links, focus mode, task highlighting by title/tag, and a mini-map.
- Task detail side panel with edit mode, due dates, start dates, links, comments, and status changes.
- Quick-add task dialog with `Ctrl+N` / `Cmd+N` and mobile FAB support.
- Workflow editor with status CRUD, ordering, transition matrix, due-date alerts, and auto-archive settings.
- Tag management with create, rename, merge, delete, and color controls.
- Global search modal with `Cmd+K` / `Ctrl+K`, MeiliSearch-backed results, and priority facets.
- Archive view for auto-archived tasks, with restore support.
- Global settings for project management and user management.
- Light/dark theme toggle with persisted theme selection.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 App Router |
| Language | TypeScript (strict) |
| API | tRPC v11 |
| Data fetching | TanStack Query v5 |
| Database | PostgreSQL 16 + Prisma 6 |
| Search | MeiliSearch 1.x |
| Graph layout/rendering | ELK.js + D3.js + React SVG |
| Auth | Auth.js v5 credentials |
| Styling | Tailwind CSS 4 |
| Containerization | Docker Compose |

## Fastest Local Setup

This is the least painful path for a fresh machine:

### Prerequisites

- Node.js 22+
- npm
- Docker Desktop or Docker Engine with Compose

You do not need a separately installed PostgreSQL or MeiliSearch instance if you use the provided Compose setup.

### 1. Clone and install dependencies

```bash
git clone https://github.com/Yappito/taskito.git taskito
cd taskito
npm install
```

### 2. Create your local env file

```bash
cp .env.example .env
```

The example file is already configured for the local Docker services:

```env
DATABASE_URL="postgresql://taskito:taskito@localhost:5432/taskito?schema=public"
AUTH_SECRET="replace-with-a-random-secret-in-production"
AUTH_URL="http://localhost:3000"
MEILI_URL="http://localhost:7700"
MEILI_MASTER_KEY="taskito-dev-meili-key"

# Optional: OpenAI-compatible API for auto-tagging
AUTO_TAGGER_URL=""
AUTO_TAGGER_API_KEY=""

# Optional: only set this to true when you explicitly want demo data in production
ALLOW_DEMO_SEED="false"
```

### 3. Start Postgres and MeiliSearch

```bash
docker compose up -d
```

This brings up:

- PostgreSQL on `localhost:5432`
- MeiliSearch on `localhost:7700`

### 4. Apply migrations

```bash
npm run db:migrate
```

### 5. Seed demo data

```bash
npm run db:seed
```

Important:

- The seed is intended for first-time setup or a fresh reset.
- Running it repeatedly will add another batch of demo tasks to the default project.

### 6. Start the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and log in with:

- the credentials created for your environment

If you ran `npm run db:seed`, the demo admin account is:

- Email: `admin@taskito.local`
- Password: `admin123`

## Local Reset

If your local state is messy, still uses old branding, or you want a completely clean demo setup:

```bash
docker compose down -v
docker compose up -d
npm run db:migrate
npm run db:seed
```

That drops local Postgres and MeiliSearch volumes and recreates the default demo dataset.

## Useful Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the local Next.js dev server |
| `npm run build` | Build the production bundle |
| `npm start` | Run the built app |
| `npm run db:migrate` | Apply Prisma dev migrations |
| `npm run db:seed` | Seed demo data |
| `npm run db:bootstrap-admin` | Create or reset an admin user using `BOOTSTRAP_ADMIN_*` env vars |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:generate` | Regenerate Prisma client |
| `npm test` | Run Vitest unit tests |
| `npx playwright test` | Run Playwright end-to-end tests |

## Production Deployment

The repo includes [docker-compose.prod.yml](docker-compose.prod.yml) for a full app + database + MeiliSearch + nginx deployment.

### 1. Create your production env file

```bash
cp .env.prod .env.prod.local
```

Update `.env.prod.local` with your real production values.

The production compose file reads these variables:

- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`
- `AUTH_SECRET`
- `AUTH_URL`
- `MEILISEARCH_KEY`

`DATABASE_URL`, `MEILISEARCH_URL`, and `AUTH_TRUST_HOST` are set by [docker-compose.prod.yml](docker-compose.prod.yml) itself.

### 2. Start the production stack

```bash
docker compose --env-file .env.prod.local -f docker-compose.prod.yml up -d --build
```

### 3. Run migrations

```bash
docker compose --env-file .env.prod.local -f docker-compose.prod.yml exec app ./node_modules/.bin/prisma migrate deploy
```

### 4. Bootstrap an admin account if you did not seed demo data

If you do **not** want demo projects/tasks, bootstrap an admin account instead:

```bash
docker compose --env-file .env.prod.local -f docker-compose.prod.yml exec \
  -e BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
  -e BOOTSTRAP_ADMIN_NAME="Initial Admin" \
  app ./node_modules/.bin/tsx prisma/bootstrap-admin.ts
```

Optional:

- Add `-e BOOTSTRAP_ADMIN_PASSWORD="use-a-strong-password"` to choose the password yourself.
- If you omit `BOOTSTRAP_ADMIN_PASSWORD`, the script generates a strong password and prints it once.
- Re-running the command for the same email resets that user's password and ensures the account has the `admin` role.

### 5. Seed initial demo data if you want it

```bash
docker compose --env-file .env.prod.local -f docker-compose.prod.yml exec app ./node_modules/.bin/tsx prisma/seed.ts
```

Only seed production if you actually want the sample project, tasks, tags, and demo admin user. Otherwise, use the admin bootstrap command above. Production demo seeding is blocked unless `ALLOW_DEMO_SEED=true` is present in the container environment. The hardcoded demo login `admin@taskito.local` / `admin123` is only created by this demo seed.

## Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `AUTH_SECRET` | Yes | Auth.js signing secret |
| `AUTH_URL` | Yes | Public base URL of the app |
| `AUTH_TRUST_HOST` | Usually | Set to `true` behind a proxy or container ingress |
| `MEILI_URL` | Yes | Local/dev MeiliSearch URL |
| `MEILI_MASTER_KEY` | Yes | Local/dev MeiliSearch key |
| `MEILISEARCH_URL` | Production compose | Alias used by the production compose file |
| `MEILISEARCH_KEY` | Production compose | Alias used by the production compose file |
| `AUTO_TAGGER_URL` | No | Optional OpenAI-compatible tagging endpoint |
| `AUTO_TAGGER_API_KEY` | No | Optional API key for the auto-tagger |

## First Things To Do In The App

1. Log in with your admin account. If you applied the demo preseed, use `admin@taskito.local` / `admin123`.
2. Open Settings → Projects and create a second project.
3. Use the project dropdown in the main toolbar to switch between projects.
4. Open a project’s Workflow settings to adjust statuses, transitions, due-date alerts, and auto-archive behavior.
5. Open a project’s Tag settings to create or merge tags.
6. Create tasks with the quick-add dialog and explore board, list, graph, and archive views.

## Project Structure

```text
src/
├── app/                    # Next.js routes
│   ├── (auth)/login/       # Login page
│   ├── (dashboard)/        # Authenticated app shell
│   │   ├── [projectSlug]/  # Project-scoped views and settings
│   │   └── settings/       # Global project/user management
│   └── api/trpc/           # tRPC route handler
├── components/
│   ├── auth/               # Login form
│   ├── graph/              # Timeline graph, nodes, edges, minimap
│   ├── task/               # Board, list, task detail, quick-add, filters
│   └── ui/                 # Reusable UI controls
├── lib/                    # Shared utilities, auth, types, tRPC client
└── server/
    ├── routers/            # tRPC routers
    └── services/           # Search and auto-tagging services
prisma/
├── schema.prisma
├── migrations/
└── seed.ts
```

## License

[MIT](LICENSE)
