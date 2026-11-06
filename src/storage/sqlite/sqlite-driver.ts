import { createRequire } from 'node:module';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StorageDriver } from '../driver.js';

// Loaded via createRequire so bundlers/test runners that predate the
// experimental node:sqlite module (and strip the `node:` prefix) leave it
// to the Node runtime instead of trying to resolve a bare "sqlite" import.
const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/**
 * SQLite driver for local development and tests (built-in node:sqlite,
 * no native dependency). Accepts ':memory:' for ephemeral databases.
 */
export class SqliteDriver implements StorageDriver {
  readonly dialect = 'sqlite' as const;
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new sqlite.DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const result = this.db.prepare(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(result.changes ?? 0) };
  }

  /**
   * SQLite rejects `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (Postgres
   * accepts it). Emulate the guard by dropping such statements when the
   * column already exists, so sqlite/007 can stay textually aligned with
   * postgres/007 and a re-run of the same file is a no-op.
   */
  private rewriteAddColumnGuards(sql: string): string {
    return sql.replace(
      /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)([^;]*);/gi,
      (_match, table: string, column: string, tail: string) => {
        const columns = this.db.prepare(`PRAGMA table_info("${table}")`).all() as {
          name: string;
        }[];
        return columns.some((c) => c.name === column)
          ? ''
          : `ALTER TABLE ${table} ADD COLUMN ${column}${tail};`;
      },
    );
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(this.rewriteAddColumnGuards(sql));
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original failure is the one that matters.
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
