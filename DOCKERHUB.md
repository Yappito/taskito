# Taskito Container Image

Taskito is a self-hosted project task manager with board, list, archive, and dependency graph views, plus workflows, tags, custom fields, comments, notifications, and admin settings.

This image is intended to be used with PostgreSQL and the provided Compose stack from the repository:

```bash
git clone https://github.com/Yappito/taskito.git
cd taskito
cp .env.example .env
docker compose up -d --pull always
```

The Compose stack starts:

- `yappito/taskito:latest` for the app
- PostgreSQL 16 for the database
- nginx for port `80` reverse proxying

On startup, the app container automatically runs `prisma migrate deploy` before starting the server.

## .env file

Create a `.env` file from `.env.example` and set these values:

- `POSTGRES_USER`: PostgreSQL username
- `POSTGRES_PASSWORD`: PostgreSQL password
- `POSTGRES_DB`: PostgreSQL database name
- `AUTH_URL`: public base URL of your deployment, for example `https://taskito.example.com`
- `AUTH_SECRET`: long random secret used by Auth.js; use at least 32 characters

Optional values:

- `AUTO_TAGGER_URL`: optional OpenAI-compatible endpoint for automatic tag suggestions
- `AUTO_TAGGER_API_KEY`: API key for the auto-tagger endpoint
- `ALLOW_DEMO_SEED`: leave `false` unless you intentionally want demo data

`DATABASE_URL` and `AUTH_TRUST_HOST=true` are injected automatically by the Compose file.

Example:

```env
POSTGRES_USER="taskito"
POSTGRES_PASSWORD="change-me"
POSTGRES_DB="taskito"
AUTH_URL="https://taskito.example.com"
AUTH_SECRET="replace-with-a-cryptographically-strong-secret"
AUTO_TAGGER_URL=""
AUTO_TAGGER_API_KEY=""
ALLOW_DEMO_SEED="false"
```

## First-time setup after startup

Create the first admin account:

```bash
docker compose exec \
  -e BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
  -e BOOTSTRAP_ADMIN_NAME="Initial Admin" \
  app npm run db:bootstrap-admin
```

Optional:

- Add `-e BOOTSTRAP_ADMIN_PASSWORD="strong-password"` to set the password explicitly.
- If omitted, the script generates a password and prints it once.

## Optional demo seed

If you want sample content for evaluation or testing, run:

```bash
docker compose exec \
  -e ALLOW_DEMO_SEED=true \
  app npm run db:seed
```

Only do this when you want demo data. The seed script is intentionally blocked unless `ALLOW_DEMO_SEED=true` is present.

The seeded demo admin account uses `admin@taskito.local` and defaults to `taskito-demo-2026`. Override it with `DEMO_ADMIN_PASSWORD` when you want a different demo credential.

## Useful operations

```bash
docker compose ps
docker compose logs -f app
docker compose exec app ./node_modules/.bin/prisma migrate deploy
docker compose exec app npm run db:generate
docker compose down
```

## Persistence

The Compose stack persists:

- PostgreSQL data in the `pgdata` Docker volume
- comment attachments in the `uploads` Docker volume mounted at `/app/uploads`

Repository and full deployment docs: https://github.com/Yappito/taskito