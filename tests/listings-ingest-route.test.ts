import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/server.js';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

/**
 * T-M9-01/J1 wire-up: POST /api/v1/listings must forward imageUrls/url into
 * PublishingService.submitListing -> ListingIngestPort. Without this passthrough
 * the VLM ingest port is unreachable from the API even when configured.
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
      title: '原始标题',
      channelAccountId: account.id,
      skus: [{ skuCode: 'SKU-INGEST-001', price: 990 }],
    }),
  });
  const { product } = (await productRes.json()) as { product: { id: string } };
  return { accountId: account.id, productId: product.id };
}

describe('POST /api/v1 listings ingestSource passthrough', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    h = await setupHarness();
    app = createApp({ services: h.services });
  });
  afterEach(async () => teardownHarness(h));

  it('forwards imageUrls (dropping blank/non-string entries) into ingest', async () => {
    const { accountId, productId } = await seedShop(app);
    const res = await app.request('/api/v1/listings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId,
        channelAccountId: accountId,
        imageUrls: ['https://img.example.com/a.jpg', '', 42],
      }),
    });
    expect(res.status).toBe(423);
    const { submission } = (await res.json()) as {
      submission: { content: { body: { title: string } } };
    };
    // Offline ingest stub replaces the product title/description, proving the
    // request body actually reached the ingest port.
    expect(submission.content.body.title).toBe(`商品 ${productId}`);
  });

  it('forwards url-only ingest sources', async () => {
    const { accountId, productId } = await seedShop(app);
    const res = await app.request('/api/v1/listings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId,
        channelAccountId: accountId,
        url: 'https://shop.example.com/p/1',
      }),
    });
    expect(res.status).toBe(423);
    const { submission } = (await res.json()) as {
      submission: { content: { body: { title: string } } };
    };
    expect(submission.content.body.title).toBe(`商品 ${productId}`);
  });

  it('stays text-only when no usable ingest source is supplied', async () => {
    const { accountId, productId } = await seedShop(app);
    const res = await app.request('/api/v1/listings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        productId,
        channelAccountId: accountId,
        imageUrls: ['', 42],
      }),
    });
    expect(res.status).toBe(423);
    const { submission } = (await res.json()) as {
      submission: { content: { body: { title: string } } };
    };
    expect(submission.content.body.title).toBe('原始标题');
  });
});
