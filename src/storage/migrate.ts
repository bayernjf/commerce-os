import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageDriver } from './driver.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root; COMMERCE_REPO_ROOT overrides it (used by tests). */
function repoRoot(): string {
  // dist/storage/migrate.js → two levels up is the repo root
  return process.env.COMMERCE_REPO_ROOT ?? join(here, '..', '..');
}
const migrationDir = (dialect: string): string =>
  join(repoRoot(), 'db', 'migrations', dialect);

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  /** Applied migrations whose recorded checksum no longer matches the file. */
  drifted: string[];
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
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

/**
 * Create the bookkeeping table with its checksum column. Databases migrated by
 * older builds already have schema_migrations without the column; add it in
 * place rather than rewriting the table.
 */
async function ensureMigrationsTable(driver: StorageDriver): Promise<void> {
  await driver.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT);',
  );
  const hasChecksum =
    driver.dialect === 'sqlite'
      ? (await driver.all<{ name: string }>('PRAGMA table_info(schema_migrations)')).some(
          (column) => column.name === 'checksum',
        )
      : (
          await driver.all<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'schema_migrations' AND table_schema = current_schema()`,
          )
        ).some((column) => column.column_name === 'checksum');
  if (!hasChecksum) {
    await driver.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;');
  }
}

export async function migrationStatus(driver: StorageDriver): Promise<MigrationStatus> {
  await ensureMigrationsTable(driver);
  const files = listMigrationFiles(driver.dialect);
  const rows = await driver.all<{ version: string; checksum: string | null }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const recorded = new Map(rows.map((row) => [row.version, row.checksum]));
  const applied = files.map((f) => f.version).filter((v) => recorded.has(v));
  return {
    applied,
    pending: files.map((f) => f.version).filter((v) => !recorded.has(v)),
    drifted: files
      .filter((f) => {
        const stored = recorded.get(f.version);
        return stored !== undefined && stored !== null && stored !== checksum(f.sql);
      })
      .map((f) => f.version),
  };
}

/**
 * Apply all pending migrations in filename order. Each file is applied inside
 * one transaction (DDL + the schema_migrations row commit or roll back
 * together), so a file that fails partway through leaves no half-applied
 * tables/seed rows behind. Applied versions carry a sha256 of their SQL text;
 * a file edited after being applied is reported as drift and migrateUp refuses
 * to run instead of silently diverging. Rows migrated before checksums existed
 * are backfilled on the next run, so drift is detectable from then on.
 */
export async function migrateUp(driver: StorageDriver): Promise<string[]> {
  const appliedNow: string[] = [];
  await ensureMigrationsTable(driver);
  const status = await migrationStatus(driver);
  if (status.drifted.length > 0) {
    throw new Error(
      `migration checksum mismatch for already-applied files: ${status.drifted.join(', ')}; refusing to migrate`,
    );
  }
  const files = listMigrationFiles(driver.dialect);

  for (const file of files) {
    if (!status.applied.includes(file.version)) continue;
    await driver.run('UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL', [
      checksum(file.sql),
      file.version,
    ]);
  }

  for (const file of files) {
    if (!status.pending.includes(file.version)) continue;
    const apply = async (): Promise<void> => {
      await driver.exec(file.sql);
      await driver.run(
        'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)',
        [file.version, new Date().toISOString(), checksum(file.sql)],
      );
    };
    if (driver.transaction) await driver.transaction(apply);
    else await apply();
    appliedNow.push(file.version);
  }
  return appliedNow;
}
