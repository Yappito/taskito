#!/bin/bash
# pg_dump backup script for Taskito
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="taskito_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "Backing up Taskito database..."
docker compose exec -T postgres pg_dump -U taskito taskito | gzip > "${BACKUP_DIR}/${FILENAME}"

echo "Backup saved to ${BACKUP_DIR}/${FILENAME}"

# Keep only last 7 backups
ls -t "${BACKUP_DIR}"/taskito_*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm
echo "Cleanup complete. Keeping last 7 backups."
