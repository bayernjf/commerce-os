#!/usr/bin/env bash
# Verifies that sqlite/ and postgres/ migration directories are paired:
# same numbering, same filenames, and the same set of CREATE TABLE names.
# Read-only; modeled on the job-agent dual-dialect convention.
set -euo pipefail

cd "$(dirname "$0")/.."
SQL_DIR="db/migrations/sqlite"
PG_DIR="db/migrations/postgres"

fail=0

sql_files=$(find "$SQL_DIR" -name '*.sql' -exec basename {} \; | sort)
pg_files=$(find "$PG_DIR" -name '*.sql' -exec basename {} \; | sort)

if [ "$sql_files" != "$pg_files" ]; then
  echo "FAIL: migration filenames are not paired between sqlite/ and postgres/"
  diff <(echo "$sql_files") <(echo "$pg_files") || true
  fail=1
fi

for f in $sql_files; do
  sql_tables=$(grep -oE 'CREATE TABLE IF NOT EXISTS [a-z_]+' "$SQL_DIR/$f" | awk '{print $NF}' | sort)
  pg_tables=$(grep -oE 'CREATE TABLE IF NOT EXISTS [a-z_]+' "$PG_DIR/$f" | awk '{print $NF}' | sort)
  if [ "$sql_tables" != "$pg_tables" ]; then
    echo "FAIL: table set mismatch in $f"
    diff <(echo "$sql_tables") <(echo "$pg_tables") || true
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "OK: paired migrations ($(echo "$sql_files" | wc -l | tr -d ' ') files each, sqlite + postgres)"
