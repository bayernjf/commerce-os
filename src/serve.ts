import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './server.js';
import { createServices } from './services.js';
import { SqliteDriver } from './storage/sqlite/sqlite-driver.js';
import { PostgresDriver } from './storage/postgres/postgres-driver.js';
import { migrateUp } from './storage/migrate.js';
import { ZeusDecisionClient } from './decision/zeus-decision-client.js';
import { LoomContentClient } from './content/loom-content-client.js';
import type { ContentClient } from './content/types.js';
import { createAlertReporter } from './observability/alerts.js';
import { logger } from './observability/logger.js';

async function main(): Promise<void> {
  const reporter = createAlertReporter();

  // Any fatal error that escapes the HTTP layer is alerted and exits non-zero
  // so the container restart policy (or orchestrator) takes over.
  process.on('unhandledRejection', (reason) => {
    reporter.report('process_fatal', 'critical', `unhandled rejection: ${String(reason)}`);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    reporter.report('process_fatal', 'critical', `uncaught exception: ${err.message}`);
    process.exit(1);
  });

  const driverKind = process.env.COMMERCE_DB_DRIVER ?? 'sqlite';
  let dataDir: string | undefined;
  const driver =
    driverKind === 'postgres'
      ? await PostgresDriver.connect(
          process.env.DATABASE_URL ?? (() => {
            throw new Error('DATABASE_URL is required when COMMERCE_DB_DRIVER=postgres');
          })(),
        )
      : (() => {
          const path = process.env.COMMERCE_SQLITE_PATH ?? './data/commerce-os.db';
          if (path !== ':memory:') {
            dataDir = dirname(path);
            mkdirSync(dataDir, { recursive: true });
          }
          return new SqliteDriver(path);
        })();

  const applied = await migrateUp(driver);
  if (applied.length > 0) logger.info('migrations applied', { migrations: applied });

  const decisions = new ZeusDecisionClient({
    baseUrl: process.env.ZEUS_BASE_URL ?? 'http://127.0.0.1:8080',
    token: process.env.ZEUS_INTERNAL_TOKEN ?? 'dev-local-token',
  });

  // LOOM_BASE_URL 设了才走真实内容底座；否则用离线桩（不触网）。
  const loomBaseUrl = process.env.LOOM_BASE_URL;
  const content: ContentClient | undefined = loomBaseUrl
    ? new LoomContentClient({
        baseUrl: loomBaseUrl,
        ...(process.env.LOOM_ACTOR_ID ? { actorId: process.env.LOOM_ACTOR_ID } : {}),
      })
    : undefined;
  const services = createServices(driver, decisions, undefined, content);

  const app = createApp({
    ...(process.env.COMMERCE_API_TOKEN ? { token: process.env.COMMERCE_API_TOKEN } : {}),
    ...(process.env.COMMERCE_STOREFRONT_CART_SECRET
      ? { storefrontCartSecret: process.env.COMMERCE_STOREFRONT_CART_SECRET }
      : {}),
    ...(process.env.COMMERCE_WEBHOOK_FAKE_SECRET
      ? { webhookSecrets: { fake: process.env.COMMERCE_WEBHOOK_FAKE_SECRET } }
      : {}),
    ...(process.env.COMMERCE_ALLOWED_ORIGINS
      ? { allowedOrigins: process.env.COMMERCE_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) }
      : {}),
    services,
    reporter,
    ...(dataDir ? { dataDir } : {}),
  });
  const port = Number(process.env.COMMERCE_PORT ?? 8787);
  const host = process.env.COMMERCE_HOST ?? '127.0.0.1';

  // node:http via @hono/node-server (Node runtime).
  const { serve } = await import('@hono/node-server');
  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    logger.info('commerce-os listening', { host, port: info.port, driver: driver.dialect });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    server.close(() => {
      driver
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    // Safety net if open connections keep the server from closing.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('startup failed', { error: (err as Error).message });
  process.exit(1);
});
