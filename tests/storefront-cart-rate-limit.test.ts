import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/server.js';
import { CART_CREATE_RATE_LIMIT } from '../src/api/routes.js';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

/**
 * P2-9 regression: POST /storefront/carts is public and unauthenticated, so it
 * must not be an unbounded write path. The limiter is in-process (single
 * instance) and keyed by client address + route.
 */
describe('public cart creation rate limit (P2-9)', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    h = await setupHarness();
    app = createApp({ services: h.services });
  });
  afterEach(async () => teardownHarness(h));

  async function createCart(ip: string): Promise<Response> {
    return app.request('/api/v1/storefront/carts', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
    });
  }

  it('allows the quota, then answers 429 with retry-after without writing a cart', async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < CART_CREATE_RATE_LIMIT.limit; i += 1) {
      expect((await createCart(ip)).status).toBe(201);
    }
    const cartsBefore = await h.driver.all('SELECT id FROM carts');
    expect(cartsBefore).toHaveLength(CART_CREATE_RATE_LIMIT.limit);

    const blocked = await createCart(ip);
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);

    // The rejected request never reaches the service: no extra cart row.
    expect(await h.driver.all('SELECT id FROM carts')).toHaveLength(CART_CREATE_RATE_LIMIT.limit);
  });

  it('keeps counters per client address', async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < CART_CREATE_RATE_LIMIT.limit; i += 1) {
      expect((await createCart(ip)).status).toBe(201);
    }
    expect((await createCart(ip)).status).toBe(429);
    // A different source address has its own bucket.
    expect((await createCart('203.0.113.9')).status).toBe(201);
  });
});
