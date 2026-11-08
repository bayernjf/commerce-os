#!/bin/sh
# Snapshot loop for the compose `backup` service.
#
# One snapshot at start, then once per interval. A failed snapshot does not
# stop the loop: the next tick retries and the failure stays in the log.
# Variables are expanded by the container shell, not by compose interpolation,
# so no `$$` escaping is involved.
set -u

DB="${COMMERCE_SQLITE_PATH:-/data/commerce-os.db}"
DIR="${COMMERCE_BACKUP_DIR:-/backups}"
KEEP="${COMMERCE_BACKUP_KEEP:-7}"
INTERVAL="${COMMERCE_BACKUP_INTERVAL_SECONDS:-86400}"
SCRIPT_DIR="$(dirname "$0")"

while true; do
  node --experimental-sqlite "$SCRIPT_DIR/backup-commerce.mjs" --db "$DB" --dir "$DIR" --keep "$KEEP" || true
  sleep "$INTERVAL"
done
