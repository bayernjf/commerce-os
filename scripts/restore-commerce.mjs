#!/usr/bin/env node
// @ts-check
/**
 * Durable-state restore for commerce-os (2026-11-08: the repo had none).
 *
 * Fail-closed by design, because the failure mode of a sloppy restore is the
 * worst one available: the process starts, serves traffic, and has silently
 * lost the refund quota ledger. Therefore:
 *
 *   1. the snapshot must carry a manifest written by backup-commerce.mjs;
 *   2. the snapshot must pass integrity_check and match the manifest counts;
 *   3. an existing target is never overwritten without --force;
 *   4. with --force, the current file is first copied to
 *      `<target>.pre-restore-<stamp>` so the restore itself is undoable;
 *   5. the restored file is re-verified before the command reports success.
 *
 * CLI:
 *   node scripts/restore-commerce.mjs --snapshot ./data/backups/snapshot-20261108T000000 \
 *     [--target-db ./data/commerce-os.db] [--force]
 */
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite');

/** Same whitelist as the backup script; table names never come from input. */
const KEY_TABLES = [
  'orders',
  'order_items',
  'payments',
  'refunds',
  'refund_line_usage',
  'checkouts',
  'fulfillments',
  'commerce_events',
];

class RestoreError extends Error {}

/** @param {Date} now */
function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', 'T');
}

/**
 * @param {string} dbFile
 * @returns {Record<string, number>}
 */
function verify(dbFile) {
  const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const value = integrity === undefined ? '' : String(Object.values(integrity)[0] ?? '');
    if (value !== 'ok') throw new RestoreError(`integrity_check failed: ${value}`);
    /** @type {Record<string, number>} */
    const counts = {};
    for (const table of KEY_TABLES) {
      try {
        const row = db.prepare(`SELECT count(*) AS c FROM ${table}`).get();
        counts[table] = Number(row?.c ?? 0);
      } catch {
        // Absent table: leave it out so it differs from a zero count.
      }
    }
    return counts;
  } finally {
    db.close();
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{snapshot?:string, target?:string, force:boolean}} */
  const parsed = { force: argv.includes('--force') };
  for (const [flag, key] of /** @type {const} */ ([
    ['--snapshot', 'snapshot'],
    ['--target-db', 'target'],
  ])) {
    const index = argv.indexOf(flag);
    if (index >= 0) {
      const value = argv[index + 1];
      if (value === undefined) throw new RestoreError(`${flag} requires a value`);
      parsed[key] = value;
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.snapshot === undefined) {
    throw new RestoreError(
      'usage: restore-commerce.mjs --snapshot <dir> [--target-db <path>] [--force]',
    );
  }
  const driver = process.env.COMMERCE_DB_DRIVER ?? 'sqlite';
  if (driver !== 'sqlite') {
    throw new RestoreError(
      `COMMERCE_DB_DRIVER=${driver} is not supported here: use pg_restore for postgres`,
    );
  }

  const snapshotDb = join(args.snapshot, 'commerce-os.db');
  const manifestPath = join(args.snapshot, 'manifest.json');
  if (!existsSync(snapshotDb)) throw new RestoreError(`snapshot has no commerce-os.db: ${args.snapshot}`);
  if (!existsSync(manifestPath)) {
    throw new RestoreError(`snapshot has no manifest.json: ${args.snapshot}`);
  }

  /** @type {{createdAt?:string, tables?:Record<string, number>}} */
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const actual = verify(snapshotDb);

  // A file that verifies but has no orders table is not a commerce-os database
  // (unmigrated or wrong file). Restoring it would serve an empty schema.
  if (actual.orders === undefined) {
    throw new RestoreError(
      `snapshot has no orders table: ${args.snapshot} is not a migrated commerce-os database`,
    );
  }

  for (const [table, expected] of Object.entries(manifest.tables ?? {})) {
    const got = actual[table];
    if (got !== expected) {
      throw new RestoreError(
        `snapshot does not match its manifest: ${table} expected ${expected}, found ${String(got)}`,
      );
    }
  }

  const target = args.target ?? process.env.COMMERCE_SQLITE_PATH ?? './data/commerce-os.db';
  if (existsSync(target)) {
    if (!args.force) {
      throw new RestoreError(
        `target exists: ${target} — re-run with --force to overwrite (it will be kept as .pre-restore)`,
      );
    }
    const keepPath = `${target}.pre-restore-${stamp(new Date())}`;
    copyFileSync(target, keepPath);
    chmodSync(keepPath, 0o600);
    console.log(`kept previous db at ${keepPath}`);
  }

  copyFileSync(snapshotDb, target);
  chmodSync(target, 0o600);

  // Re-verify the file we actually wrote, not the one we read.
  const restored = verify(target);
  const counts = Object.entries(restored)
    .map(([table, count]) => `${table}=${count}`)
    .join(' ');
  console.log(`restored ${target} from ${manifest.createdAt ?? 'unknown'} snapshot (${counts})`);
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('restore-commerce.mjs') || process.argv[1].endsWith('restore-commerce'));

if (invokedAsScript) {
  try {
    main();
  } catch (err) {
    console.error(`restore-commerce: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
