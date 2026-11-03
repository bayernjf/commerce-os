import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  OfflineListingIngest,
  RejectingListingIngest,
  createListingIngest,
} from '../src/publishing/listing-ingest.js';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

describe('ListingIngestPort (T-M9-01/J1)', () => {
  it('offline ingest is deterministic and records evidence refs', async () => {
    const p = new OfflineListingIngest();
    const input = { productId: 'prd_1', channel: 'sandbox-douyin', imageUrls: ['https://img.example.com/x.jpg'] };
    const r = await p.ingest(input);
    expect(r.title).toContain('prd_1');
    expect(r.sellingPoints.length).toBeGreaterThan(0);
    expect(r.evidenceRefs).toEqual(['https://img.example.com/x.jpg']);
    const again = await p.ingest(input);
    expect(again).toEqual(r);
  });

  it('rejecting ingest fails closed with CREDENTIAL_MISSING', async () => {
    const p = new RejectingListingIngest('no VLM model');
    await expect(p.ingest({ productId: 'x', channel: 'y' })).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
    });
  });

  it('factory selects offline by default and rejecting online', () => {
    expect(createListingIngest('offline').mode).toBe('offline');
    expect(createListingIngest('online').mode).toBe('online');
  });
});

describe('PublishingService ingestSource (T-M9-01/J1)', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => teardownHarness(h));

  it('enriches the listing from ingestSource before content generation', async () => {
    const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: 'shop' });
    const product = await h.services.products.createProduct({
      title: '原始标题',
      channelAccountId: account.id,
      skus: [{ skuCode: 'SKU-1', price: 100 }],
    });
    const submitted = await h.services.publishing.submitListing({
      productId: product.id,
      channelAccountId: account.id,
      ingestSource: { imageUrls: ['https://img.example.com/p1.jpg'] },
    });
    // OfflineListingIngest overwrites the title and selling points.
    expect(submitted.content.body.title).toContain('商品');
    expect(submitted.content.body.text).toContain('离线 ingest 提取');
  });

  it('keeps caller sellingPoints when no ingestSource is given', async () => {
    const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: 'shop' });
    const product = await h.services.products.createProduct({
      title: '原始标题',
      channelAccountId: account.id,
      skus: [{ skuCode: 'SKU-1', price: 100 }],
    });
    const submitted = await h.services.publishing.submitListing({
      productId: product.id,
      channelAccountId: account.id,
      sellingPoints: ['大容量'],
    });
    expect(submitted.content.body.title).toBe('原始标题');
    expect(submitted.content.body.text).toContain('大容量');
  });

  it('an unsettled approval (blocked) never executes the listing (P2-1)', async () => {
    const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: 'shop' });
    const product = await h.services.products.createProduct({
      title: '待审商品',
      channelAccountId: account.id,
      skus: [{ skuCode: 'SKU-HELD', price: 100 }],
    });
    const submitted = await h.services.publishing.submitListing({
      productId: product.id,
      channelAccountId: account.id,
    });
    expect(submitted.status).toBe('awaiting_approval');
    h.zeus.nextApproveStatus = 'blocked';
    await expect(h.services.publishing.approveListing(submitted.decisionId!, 'ops')).rejects.toMatchObject({ code: 'CONFLICT' });
    const listed = await h.services.events.list({ eventType: 'product.listed' });
    expect(listed).toHaveLength(0);
  });
});
