#!/usr/bin/env node
// Migration CLI: node scripts/migrate.mjs up|status [--driver sqlite|postgres]
// SQLite uses the built-in node:sqlite; postgres lazily requires `pg`.
import { SqliteDriver } from '../dist/storage/sqlite/sqlite-driver.js';
import { PostgresDriver } from '../dist/storage/postgres/postgres-driver.js';
import { migrateUp, migrationStatus } from '../dist/storage/migrate.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

async function main() {
  const command = process.argv[2];
  const driverArg = process.argv.includes('--driver')
    ? process.argv[process.argv.indexOf('--driver') + 1]
    : process.env.COMMERCE_DB_DRIVER || 'sqlite';

  let driver;
  if (driverArg === 'sqlite') {
    const path = process.env.COMMERCE_SQLITE_PATH || './data/commerce-os.db';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    driver = new SqliteDriver(path);
  } else if (driverArg === 'postgres') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required for --driver postgres');
    driver = await PostgresDriver.connect(url);
  } else {
    throw new Error(`Unknown driver: ${driverArg}`);
  }

  try {
    if (command === 'up') {
      const applied = await migrateUp(driver);
      console.log(`applied: ${applied.length === 0 ? '(none, already up to date)' : applied.join(', ')}`);
    } else if (command === 'status') {
      const status = await migrationStatus(driver);
      console.log(`applied: ${status.applied.join(', ') || '(none)'}`);
      console.log(`pending: ${status.pending.join(', ') || '(none)'}`);
    } else {
      throw new Error('usage: migrate.mjs up|status [--driver sqlite|postgres]');
    }
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
