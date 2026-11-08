#!/usr/bin/env node
// @ts-check
/**
 * Durable-state backup for commerce-os (2026-11-08: the repo had none).
 *
 * What makes this repo different from zeus and model-hub: the unrecoverable
 * state is small but not derivable. `orders` / `payments` are the money facts,
 * and `refund_line_usage` is the database-level ledger that keeps concurrent
 * refunds from double-spending a line. It cannot be recomputed from orders,
 * so a lost file is a lost quota ledger, not just a lost cache.
 *
 * One consistent SQLite snapshot via VACUUM INTO (no need to stop the process),
 * then the snapshot is verified before it is kept: integrity_check plus per-table
 * counts written into manifest.json. A snapshot that fails verification is
 * deleted and the command exits 1 — a suspicious backup must not look like a
 * good one.
 *
 * CLI:
 *   node scripts/backup-commerce.mjs [--db ./data/commerce-os.db] \
 *     [--dir ./data/backups] [--keep 7]
 *
 * Postgres deployments are refused explicitly: dumping a PG database needs
 * pg_dump, and silently pretending to back up would be worse than failing.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite');

/** Tables whose row counts must survive a restore, in audit order. */
export const KEY_TABLES = [
  'orders',
  'order_items',
  'payments',
  'refunds',
  'refund_line_usage',
  'checkouts',
  'fulfillments',
  'commerce_events',
];

/** @param {Date} now */
function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', 'T');
}

/** @param {string} path */
function sqlQuote(path) {
  return path.replaceAll("'", "''");
}

/**
 * @param {{dbFile:string, backupDir:string, keep:number, now?:Date}} opts
 * @returns {{id:string, dir:string, counts:Record<string,number>}}
 */
export function backupSnapshot(opts) {
  const now = opts.now ?? new Date();
  if (!existsSync(opts.dbFile)) {
    throw new Error(`db file not found: ${opts.dbFile}`);
  }

  const id = `snapshot-${stamp(now)}`;
  const dir = join(opts.backupDir, id);
  if (existsSync(dir)) throw new Error(`snapshot already exists: ${dir}`);
  mkdirSync(dir, { recursive: true });

  const target = join(dir, 'commerce-os.db');
  const src = new sqlite.DatabaseSync(opts.dbFile, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${sqlQuote(target)}'`);
  } finally {
    src.close();
  }

  // Verify before advertising: a corrupt snapshot is deleted, not kept.
  let counts;
  try {
    counts = verifySnapshot(target);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  const manifest = {
    id,
    createdAt: now.toISOString(),
    sourcePath: opts.dbFile,
    dbBytes: statSync(target).size,
    sha256: sha256(target),
    integrity: 'ok',
    tables: counts,
  };
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  chmodSync(target, 0o600);
  chmodSync(dir, 0o700);
  return { id, dir, counts };
}

/**
 * @param {string} dbFile
 * @returns {Record<string, number>}
 */
export function verifySnapshot(dbFile) {
  const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const value = integrity === undefined ? '' : String(Object.values(integrity)[0] ?? '');
    if (value !== 'ok') throw new Error(`integrity_check failed: ${value}`);
    /** @type {Record<string, number>} */
    const counts = {};
    for (const table of KEY_TABLES) {
      try {
        const row = db.prepare(`SELECT count(*) AS c FROM ${table}`).get();
        counts[table] = Number(row?.c ?? 0);
      } catch {
        // Table absent in an older schema: record nothing rather than 0,
        // so a missing table is distinguishable from an empty one.
      }
    }
    return counts;
  } finally {
    db.close();
  }
}

/** @param {string} file */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * @param {string} backupDir
 * @param {number} keep
 * @returns {string[]} removed ids
 */
export function pruneSnapshots(backupDir, keep) {
  if (!existsSync(backupDir)) return [];
  const dirs = readdirSync(backupDir)
    .filter(name => name.startsWith('snapshot-'))
    .sort();
  const remove = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const name of remove) rmSync(join(backupDir, name), { recursive: true, force: true });
  return remove;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{db?:string, dir?:string, keep?:string, driver?:string}} */
  const parsed = {};
  const map = { '--db': 'db', '--dir': 'dir', '--keep': 'keep', '--driver': 'driver' };
  for (const [flag, key] of Object.entries(map)) {
    const index = argv.indexOf(flag);
    if (index >= 0) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      parsed[key] = value;
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const driver = args.driver ?? process.env.COMMERCE_DB_DRIVER ?? 'sqlite';
  if (driver !== 'sqlite') {
    throw new Error(
      `--driver ${driver} is not supported by this script: use pg_dump/pg_restore for postgres ` +
        `(e.g. pg_dump --format=custom "$DATABASE_URL" > commerce-$(date +%Y%m%dT%H%M%S).dump)`,
    );
  }

  const dbFile = args.db ?? process.env.COMMERCE_SQLITE_PATH ?? './data/commerce-os.db';
  const backupDir = args.dir ?? './data/backups';
  const keep = Math.max(1, Number.parseInt(args.keep ?? '7', 10) || 7);

  mkdirSync(backupDir, { recursive: true });
  const result = backupSnapshot({ dbFile, backupDir, keep });
  const removed = pruneSnapshots(backupDir, keep);
  const counts = Object.entries(result.counts)
    .map(([table, count]) => `${table}=${count}`)
    .join(' ');
  console.log(`wrote ${result.dir} (${counts})`);
  if (removed.length > 0) console.log(`pruned: ${removed.join(', ')}`);
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('backup-commerce.mjs') || process.argv[1].endsWith('backup-commerce'));

if (invokedAsScript) {
  try {
    main();
  } catch (err) {
    console.error(`backup-commerce: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
