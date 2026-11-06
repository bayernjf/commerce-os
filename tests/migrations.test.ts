import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp, migrationStatus } from '../src/storage/migrate.js';

const root = process.cwd();
const sqliteDir = join(root, 'db/migrations/sqlite');
const pgDir = join(root, 'db/migrations/postgres');

describe('migration parity (dual dialect)', () => {
  it('sqlite and postgres directories contain paired filenames', () => {
    const sqliteFiles = readdirSync(sqliteDir).filter((f) => f.endsWith('.sql')).sort();
    const pgFiles = readdirSync(pgDir).filter((f) => f.endsWith('.sql')).sort();
    expect(pgFiles).toEqual(sqliteFiles);
  });

  it('each migration creates the same table set in both dialects', () => {
    const tables = (dir: string, file: string): string[] =>
      [...readFileSync(join(dir, file), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1] ?? '').sort();
    for (const file of readdirSync(sqliteDir).filter((f) => f.endsWith('.sql'))) {
      expect(tables(pgDir, file)).toEqual(tables(sqliteDir, file));
    }
  });

  it('check-migrations.sh passes', () => {
    const output = execFileSync('bash', [join(root, 'scripts/check-migrations.sh')], { encoding: 'utf8' });
    expect(output).toContain('OK: paired migrations');
  });
});

describe('sqlite migration runner', () => {
  it('applies all migrations and is idempotent on a second run', async () => {
    const driver = new SqliteDriver(':memory:');
    const first = await migrateUp(driver);
    expect(first).toEqual(['001_init', '002_customer_service', '003_storefront', '004_webhook', '005_checkout_snapshot', '006_refund_line_usage', '007_checkout_integrity']);
    const status = await migrationStatus(driver);
    expect(status.pending).toEqual([]);
    expect(status.drifted).toEqual([]);
    const second = await migrateUp(driver);
    expect(second).toEqual([]);
    await driver.close();
  });

  it('re-runs sqlite 007 twice without error (idempotent DDL)', async () => {
    const driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    const sql = readFileSync(join(sqliteDir, '007_checkout_integrity.sql'), 'utf8');
    await driver.exec(sql);
    await driver.exec(sql);
    const columns = await driver.all<{ name: string }>('PRAGMA table_info(checkouts)');
    expect(columns.filter((column) => column.name === 'provider')).toHaveLength(1);
    const indexes = await driver.all<{ name: string }>('PRAGMA index_list(payments)');
    expect(indexes.some((index) => index.name === 'payments_checkout_id_uniq')).toBe(true);
    await driver.close();
  });

  it('records a sha256 checksum for every applied migration', async () => {
    const driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    const rows = await driver.all<{ version: string; checksum: string | null }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);
    }
    await driver.close();
  });

  it('flags an edited already-applied migration and refuses to migrate', async () => {
    const driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    // Simulate a file that changed after it was applied: the recorded digest
    // no longer matches the file on disk.
    await driver.run(`UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = '001_init'`);

    const status = await migrationStatus(driver);
    expect(status.drifted).toEqual(['001_init']);
    await expect(migrateUp(driver)).rejects.toThrowError(/migration checksum mismatch/);
    await driver.close();
  });

  it('rolls a failing migration file back as a unit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'commerce-migrations-'));
    mkdirSync(join(root, 'db', 'migrations', 'sqlite'), { recursive: true });
    writeFileSync(
      join(root, 'db', 'migrations', 'sqlite', '001_rollback_ok.sql'),
      `CREATE TABLE IF NOT EXISTS t_rollback_ok (id TEXT PRIMARY KEY);
       INSERT INTO t_rollback_ok (id) VALUES ('one');`,
    );
    writeFileSync(
      join(root, 'db', 'migrations', 'sqlite', '002_rollback_bad.sql'),
      `CREATE TABLE IF NOT EXISTS t_rollback_bad (id TEXT PRIMARY KEY);
       INSERT INTO t_missing_table (id) VALUES ('boom');`,
    );
    process.env.COMMERCE_REPO_ROOT = root;
    const driver = new SqliteDriver(':memory:');
    try {
      await expect(migrateUp(driver)).rejects.toThrowError(/no such table/);

      // 001 committed; 002 created a table and then failed, so its DDL must
      // have rolled back with the file and only 001 stays recorded.
      const tables = await driver.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('t_rollback_ok', 't_rollback_bad')`,
      );
      expect(tables.map((t) => t.name)).toEqual(['t_rollback_ok']);
      const recorded = await driver.all<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(recorded.map((r) => r.version)).toEqual(['001_rollback_ok']);
    } finally {
      delete process.env.COMMERCE_REPO_ROOT;
      await driver.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
