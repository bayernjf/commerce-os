import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './server.js';
import { createServices } from './services.js';
import { SqliteDriver } from './storage/sqlite/sqlite-driver.js';
import { PostgresDriver } from './storage/postgres/postgres-driver.js';
import { migrateUp } from './storage/migrate.js';
import { ZeusDecisionClient } from './decision/zeus-decision-client.js';

async function main(): Promise<void> {
  const driverKind = process.env.COMMERCE_DB_DRIVER ?? 'sqlite';
  const driver =
    driverKind === 'postgres'
      ? await PostgresDriver.connect(
          process.env.DATABASE_URL ?? (() => {
            throw new Error('DATABASE_URL is required when COMMERCE_DB_DRIVER=postgres');
          })(),
        )
      : (() => {
          const path = process.env.COMMERCE_SQLITE_PATH ?? './data/commerce-os.db';
          if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
          return new SqliteDriver(path);
        })();

  const applied = await migrateUp(driver);
  if (applied.length > 0) console.log(`migrations applied: ${applied.join(', ')}`);

  const decisions = new ZeusDecisionClient({
    baseUrl: process.env.ZEUS_BASE_URL ?? 'http://127.0.0.1:8080',
    token: process.env.ZEUS_INTERNAL_TOKEN ?? 'dev-local-token',
  });
  const services = createServices(driver, decisions);

  const app = createApp({
    ...(process.env.COMMERCE_API_TOKEN ? { token: process.env.COMMERCE_API_TOKEN } : {}),
    services,
  });
  const port = Number(process.env.COMMERCE_PORT ?? 8787);
  const host = process.env.COMMERCE_HOST ?? '127.0.0.1';

  // node:http via @hono/node-server (Node runtime).
  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`commerce-os listening on http://${host}:${info.port} (driver=${driver.dialect})`);
  });
}

main().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});
