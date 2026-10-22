import type { StorageDriver } from '../driver.js';

/**
 * Postgres driver for production. The `pg` package is an optional
 * dependency that is NOT installed in local CI: constructing this driver
 * without it fails closed with an actionable error instead of silently
 * falling back to another dialect.
 *
 * Business SQL uses `?` placeholders; this driver converts them to `$1..$n`.
 */
export class PostgresDriver implements StorageDriver {
  readonly dialect = 'postgres' as const;
  // Minimal structural surface of pg.Client used here.
  private readonly client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
    end: () => Promise<void>;
  };

  private constructor(client: PostgresDriver['client']) {
    this.client = client;
  }

  static async connect(connectionString: string): Promise<PostgresDriver> {
    let pg: { Client: new (config: { connectionString: string }) => PostgresDriver['client'] };
    try {
      // `pg` is an optional production dependency that is not installed in
      // local CI; its types are intentionally absent here.
      // @ts-expect-error -- optional runtime dependency, see class doc
      pg = (await import('pg')) as typeof pg;
    } catch {
      throw new Error(
        'Postgres driver requested but the optional `pg` dependency is not installed. Run `npm install pg` in the production environment.',
      );
    }
    const client = new pg.Client({ connectionString });
    await client.query('SELECT 1');
    return new PostgresDriver(client);
  }

  private static toDollarParams(sql: string): { text: string; count: number } {
    let count = 0;
    const text = sql.replace(/\?/g, () => `$${++count}`);
    return { text, count };
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const { text } = PostgresDriver.toDollarParams(sql);
    const result = await this.client.query(text, [...params]);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const { text } = PostgresDriver.toDollarParams(sql);
    const result = await this.client.query(text, [...params]);
    return { changes: result.rowCount };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}
