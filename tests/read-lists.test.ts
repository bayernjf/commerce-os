import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/server.js';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

/**
 * Read-only list/detail endpoints (ops-console T-M8 gap closure):
 *   GET /api/v1/refunds        (list)
 *   GET /api/v1/refunds/:id    (detail — already existed)
 *   GET /api/v1/content        (list, projected from product.listed events)
 *   GET /api/v1/content/:id    (detail by externalContentId)
 *
 * Auth: the bearer middleware lives in route registration, so the auth-failure
 * gates are exercised over HTTP with a configured token.
 */

async function seedShop(app: Hono): Promise<{ accountId: string; productId: string }> {
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
  const { product } = (await productRes.json()) as { product: { id: string } };
  return { accountId: account.id, productId: product.id };
}

async function seedPublishedContent(app: Hono, accountId: string, productId: string): Promise<void> {
  const listingRes = await app.request('/api/v1/listings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId, channelAccountId: accountId }),
  });
  expect(listingRes.status).toBe(423);
  const { submission } = (await listingRes.json()) as { submission: { decisionId: string } };
  const approveRes = await app.request(`/api/v1/listings/${submission.decisionId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approver: 'owner' }),
  });
  expect(approveRes.status).toBe(200);
}

describe('read-only list/detail endpoints', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    h = await setupHarness();
    app = createApp({ services: h.services });
  });
  afterEach(async () => teardownHarness(h));

  it('GET /api/v1/refunds returns an empty list when no refunds exist', async () => {
    const res = await app.request('/api/v1/refunds');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refunds: unknown[] };
    expect(body.refunds).toEqual([]);
  });

  it('GET /api/v1/refunds lists seeded refunds and each id reads back via detail', async () => {
    const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: 'shop' });
    const imported = await h.services.orders.importFromChannel(account.id);
    const order = await h.services.orders.getOrder(imported.imported[0]!.id);
    const held = await h.services.aftersales.requestRefund(order.id, {
      lines: [{ orderItemId: order.lines[0]!.id }],
      reason: '七天无理由',
    });

    const listRes = await app.request('/api/v1/refunds');
    expect(listRes.status).toBe(200);
    const { refunds } = (await listRes.json()) as { refunds: { id: string; orderId: string; status: string }[] };
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.id).toBe(held.id);
    expect(refunds[0]?.orderId).toBe(order.id);
    expect(refunds[0]?.status).toBe('awaiting_approval');

    const detailRes = await app.request(`/api/v1/refunds/${held.id}`);
    expect(detailRes.status).toBe(200);
    const { refund } = (await detailRes.json()) as { refund: { id: string } };
    expect(refund.id).toBe(held.id);
  });

  it('GET /api/v1/refunds/:unknown-id returns 404 NOT_FOUND', async () => {
    const res = await app.request('/api/v1/refunds/rfd_missing');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/v1/content returns an empty list when nothing is published', async () => {
    const res = await app.request('/api/v1/content');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: unknown[] };
    expect(body.content).toEqual([]);
  });

  it('GET /api/v1/content projects published listings and reads back by id', async () => {
    const { accountId, productId } = await seedShop(app);
    await seedPublishedContent(app, accountId, productId);

    const listRes = await app.request('/api/v1/content');
    expect(listRes.status).toBe(200);
    const { content } = (await listRes.json()) as {
      content: { id: string; productId: string; channel: string; externalProductId: string }[];
    };
    expect(content).toHaveLength(1);
    expect(content[0]?.id).toBe('DY-SB-CONTENT-7001');
    expect(content[0]?.productId).toBe(productId);
    expect(content[0]?.channel).toBe('sandbox-douyin');
    expect(typeof content[0]?.externalProductId).toBe('string');

    const detailRes = await app.request(`/api/v1/content/DY-SB-CONTENT-7001`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { content: { id: string; productId: string } };
    expect(detail.content.id).toBe('DY-SB-CONTENT-7001');
    expect(detail.content.productId).toBe(productId);
  });

  it('GET /api/v1/content/:unknown-id returns 404 NOT_FOUND', async () => {
    const res = await app.request('/api/v1/content/NO-SUCH-CONTENT');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('read-only list endpoints auth (token configured)', () => {
  let h: TestHarness;
  let secured: ReturnType<typeof createApp>;

  beforeEach(async () => {
    h = await setupHarness();
    secured = createApp({ token: 'secret', services: h.services });
  });
  afterEach(async () => teardownHarness(h));

  it('refunds list/detail reject missing or wrong bearer token (401)', async () => {
    expect((await secured.request('/api/v1/refunds')).status).toBe(401);
    expect((await secured.request('/api/v1/refunds/rfd_x', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('content list/detail reject missing or wrong bearer token (401)', async () => {
    expect((await secured.request('/api/v1/content')).status).toBe(401);
    expect((await secured.request('/api/v1/content/c_x', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('both lists return 200 with the correct bearer token', async () => {
    const headers = { Authorization: 'Bearer secret' };
    expect((await secured.request('/api/v1/refunds', { headers })).status).toBe(200);
    expect((await secured.request('/api/v1/content', { headers })).status).toBe(200);
  });
});
