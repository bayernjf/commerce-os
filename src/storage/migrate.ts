import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageDriver } from './driver.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/src/storage/migrate.js → repo root is three levels up
const repoRoot = process.env.COMMERCE_REPO_ROOT ?? join(here, '..', '..');
const migrationDir = (dialect: string): string =>
  join(repoRoot, 'db', 'migrations', dialect);

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

function listMigrationFiles(dialect: string): { version: string; file: string; sql: string }[] {
  const dir = migrationDir(dialect);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({
      version: file.replace(/\.sql$/, ''),
      file,
      sql: readFileSync(join(dir, file), 'utf8'),
    }));
}

async function ensureMigrationsTable(driver: StorageDriver): Promise<void> {
  await driver.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
}

export async function migrationStatus(driver: StorageDriver): Promise<MigrationStatus> {
  await ensureMigrationsTable(driver);
  const files = listMigrationFiles(driver.dialect);
  const rows = await driver.all<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  return {
    applied: files.map((f) => f.version).filter((v) => applied.has(v)),
    pending: files.map((f) => f.version).filter((v) => !applied.has(v)),
  };
}

/**
 * Apply all pending migrations in filename order. Records are inserted
 * inside the same exec as the DDL for drivers that allow it; for portability
 * we record after each file and the DDL is IF NOT EXISTS idempotent.
 */
export async function migrateUp(driver: StorageDriver): Promise<string[]> {
  const appliedNow: string[] = [];
  await ensureMigrationsTable(driver);
  const status = await migrationStatus(driver);
  const files = listMigrationFiles(driver.dialect);
  for (const file of files) {
    if (!status.pending.includes(file.version)) continue;
    await driver.exec(file.sql);
    await driver.run(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      [file.version, new Date().toISOString()],
    );
    appliedNow.push(file.version);
  }
  return appliedNow;
}
