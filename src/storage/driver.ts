/**
 * Storage driver port. The dialect boundary lives here: business code only
 * ever sees SQL with `?` placeholders and ANSI-shaped CRUD. Each driver
 * translates placeholders/connection details for its database.
 */
export interface StorageDriver {
  readonly dialect: 'sqlite' | 'postgres';
  /** Execute a SELECT, returning rows. */
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Execute a SELECT, returning the first row or undefined. */
  get<T>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  /** Execute an INSERT/UPDATE/DELETE. */
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
  /** Raw multi-statement execution (migrations only). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
