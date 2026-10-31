import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/server.js';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

describe('HTTP API v1 smoke', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    h = await setupHarness();
    app = createApp({ services: h.services });
  });
  afterEach(async () => teardownHarness(h));

  it('healthz reports service and dialect', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string; db: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('commerce-os');
    expect(body.db).toBe('sqlite');
  });

  it('import from a missing channel account returns 404', async () => {
    const res = await app.request('/api/v1/orders/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelAccountId: 'acc_missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('live channel account without credentialRef fails closed with 422', async () => {
    const res = await app.request('/api/v1/channel-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'douyin', displayName: 'live shop' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CREDENTIAL_MISSING');
  });

  it('full loop over HTTP: account → product → listing 423 → approve → import → refund → approve', async () => {
    const accountRes = await app.request('/api/v1/channel-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'sandbox-douyin', displayName: 'shop' }),
    });
    const { account } = (await accountRes.json()) as { account: { id: string } };

    const productRes = await app.request('/api/v1/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '演示商品',
        channelAccountId: account.id,
        skus: [{ skuCode: 'SKU-DEMO-001', price: 1299 }],
      }),
    });
    expect(productRes.status).toBe(201);
    const { product } = (await productRes.json()) as { product: { id: string } };

    const listingRes = await app.request('/api/v1/listings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: product.id, channelAccountId: account.id }),
    });
    expect(listingRes.status).toBe(423);
    const { submission } = (await listingRes.json()) as { submission: { decisionId: string } };

    const approveRes = await app.request(`/api/v1/listings/${submission.decisionId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'owner' }),
    });
    expect(approveRes.status).toBe(200);

    const importRes = await app.request('/api/v1/orders/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelAccountId: account.id }),
    });
    const { result } = (await importRes.json()) as { result: { imported: { id: string; lines: { id: string }[] }[] } };
    const order = result.imported[0]!;

    const refundRes = await app.request('/api/v1/refunds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: order.id, lines: [{ orderItemId: order.lines[0]!.id }], reason: 'x' }),
    });
    expect(refundRes.status).toBe(423);
    const { refund } = (await refundRes.json()) as { refund: { id: string } };

    const finalRes = await app.request(`/api/v1/refunds/${refund.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve', approver: 'owner' }),
    });
    const final = (await finalRes.json()) as { refund: { status: string; externalRefundRef: string } };
    expect(final.refund.status).toBe('succeeded');
    expect(final.refund.externalRefundRef).toBe('DY-SB-REFUND-5001');
  });

  it('payment placeholder returns 501', async () => {
    const res = await app.request('/api/v1/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_IMPLEMENTED_PLACEHOLDER');
  });

  it('bearer token is enforced when configured', async () => {
    const secured = createApp({ token: 'secret', services: h.services });
    const noToken = await secured.request('/api/v1/products');
    expect(noToken.status).toBe(401);
    const withToken = await secured.request('/api/v1/products', { headers: { Authorization: 'Bearer secret' } });
    expect(withToken.status).toBe(200);
  });

  it('unknown exceptions return a generic ProblemDetails body without echoing the error text', async () => {
    // Tier0 review 2026-10-30 H2: the global 500 handler used to echo
    // err.message, leaking driver/table details. A non-CommerceError escaping
    // a route must produce a generic RFC 9457 body, with the original text
    // kept on the server side (alert reporter) only.
    const reported: string[] = [];
    const reporter = {
      report: (kind: string, severity: string, message: string): void => {
        void kind;
        void severity;
        reported.push(message);
      },
    };
    const broken = createApp({ services: h.services, reporter: reporter as unknown as import('../src/observability/alerts.js').AlertReporter });
    const products = h.services.products as unknown as Record<string, unknown>;
    const originalList = products.listCategories;
    products.listCategories = async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:5432 — relation categories missing');
    };
    try {
      const res = await broken.request('/api/v1/categories');
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'internal error',
        instance: '/api/v1/categories',
      });
      const raw = JSON.stringify(body);
      expect(raw).not.toContain('ECONNREFUSED');
      expect(raw).not.toContain('categories missing');
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain('ECONNREFUSED');
    } finally {
      products.listCategories = originalList;
    }
  });
});
