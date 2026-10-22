import { Hono } from 'hono';
import type { CommerceServices } from './services.js';
import { registerHttpRoutes } from './api/routes.js';

export interface CommerceAppDeps {
  token?: string;
  services: CommerceServices;
}

/**
 * Build the Hono app. Pure factory: no socket is opened here.
 */
export function createApp(deps: CommerceAppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) =>
    c.json({ ok: true, service: 'commerce-os', db: deps.services.driver.dialect, time: new Date().toISOString() }),
  );

  registerHttpRoutes(app, deps);

  return app;
}
