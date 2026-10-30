import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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
    expect(first).toEqual(['001_init', '002_customer_service', '003_storefront', '004_webhook', '005_checkout_snapshot']);
    const status = await migrationStatus(driver);
    expect(status.pending).toEqual([]);
    const second = await migrateUp(driver);
    expect(second).toEqual([]);
    await driver.close();
  });
});
