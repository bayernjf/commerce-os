import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { CommerceServices } from './services.js';
import { registerHttpRoutes } from './api/routes.js';
import type { AlertReporter } from './observability/alerts.js';
import { checkReadiness } from './observability/readiness.js';

export interface CommerceAppDeps {
  token?: string;
  /** Secret for stateless storefront cart tokens (Cart <token> scheme). */
  storefrontCartSecret?: string;
  /** Per-provider webhook HMAC secrets, keyed by provider name. */
  webhookSecrets?: Record<string, string>;
  services: CommerceServices;
  reporter?: AlertReporter;
  /** Data volume directory, used for the disk readiness probe. */
  dataDir?: string;
  /**
   * Browser origins allowed for /api/v1/*. Defaults to local dev origins
   * (Astro dev/preview on 4321); production must set COMMERCE_ALLOWED_ORIGINS.
   */
  allowedOrigins?: string[];
}

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:4321', 'http://127.0.0.1:4321'];

/**
 * Build the Hono app. Pure factory: no socket is opened here.
 */
export function createApp(deps: CommerceAppDeps): Hono {
  const app = new Hono();

  // Browser cross-origin access for the storefront islands (cart/checkout).
  // Origin allow-list: explicit env in production, local dev default here.
  app.use(
    '/api/v1/*',
    cors({
      origin: deps.allowedOrigins?.length ? deps.allowedOrigins : DEFAULT_ALLOWED_ORIGINS,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  // Liveness: process is up. No dependency probes here so a transiently
  // failing dependency does not get the container killed (restart loop).
  app.get('/healthz', (c) =>
    c.json({ ok: true, service: 'commerce-os', db: deps.services.driver.dialect, time: new Date().toISOString() }),
  );

  // Readiness: real dependency round-trips; traffic is only routed when 200.
  app.get('/readyz', async (c) => {
    const result = await checkReadiness(deps.services.driver, {
      ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    });
    if (!result.ready) {
      deps.reporter?.report('readiness_failed', 'critical', 'readiness probe failed', {
        checks: result.checks,
      });
      return c.json({ ready: false, checks: result.checks }, 503);
    }
    return c.json({ ready: true, checks: result.checks });
  });

  registerHttpRoutes(app, deps);

  return app;
}
