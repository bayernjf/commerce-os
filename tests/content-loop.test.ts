import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { createServices, type CommerceServices } from '../src/services.js';
import { ZeusDecisionClient } from '../src/decision/zeus-decision-client.js';
import { LoomContentClient } from '../src/content/loom-content-client.js';
import { FakeZeusServer } from './helpers/fake-zeus-server.js';
import { FakeLoomServer } from './helpers/fake-loom-server.js';

/**
 * T-M4-05 / GATE-M4 content loop: commerce uses the real loom content-base
 * HTTP client (against a recorded loom) to drive one piece of e-commerce
 * content through request → candidate → review → listing reference, with no
 * external credentials.
 */
describe('GATE-M4 content loop over loom content-base', () => {
  let zeus: FakeZeusServer;
  let loom: FakeLoomServer;
  let driver: SqliteDriver;
  let services: CommerceServices;

  beforeEach(async () => {
    zeus = new FakeZeusServer();
    loom = new FakeLoomServer();
    const [zeusUrl, loomUrl] = await Promise.all([zeus.start(), loom.start()]);
    driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    const decisions = new ZeusDecisionClient({ baseUrl: zeusUrl, token: zeus.token });
    const content = new LoomContentClient({ baseUrl: loomUrl, actorId: 'commerce-loop' });
    services = createServices(driver, decisions, undefined, content);
  });

  afterEach(async () => {
    await driver.close();
    await zeus.stop();
    await loom.stop();
  });

  it('drives content request → candidate → review → listing reference', async () => {
    const account = await services.accounts.create({ channel: 'sandbox-douyin', displayName: '沙箱抖店' });
    const product = await services.products.createProduct({
      title: '闭环演示商品',
      channelAccountId: account.id,
      skus: [{ skuCode: 'SKU-LOOP-01', specs: { model: 'std' }, price: 99, currency: 'CNY' }],
    });

    // request → candidate (content-base), listing graded D3 and held.
    const submitted = await services.publishing.submitListing({
      productId: product.id,
      channelAccountId: account.id,
      contentType: 'detail',
      sellingPoints: ['轻便', '耐用'],
    });
    expect(submitted.status).toBe('awaiting_approval');
    expect(submitted.content.source).toBe('content-base');
    expect(submitted.content.status).toBe('pending_review');
    expect(submitted.content.evidenceRefs).toContain('llm:agnes-3.0-flash');

    // approval → content review (confirmed) → upsert + publish references it.
    const listed = await services.publishing.approveListing(submitted.decisionId, 'owner', '可上架');
    expect(listed.status).toBe('listed');
    expect(listed.content.status).toBe('confirmed');
    expect(listed.externalContentId).toBeTruthy();
    expect(listed.externalProductId).toBeTruthy();

    // content-to-product linkage is queryable in the audit trail.
    const events = await services.events.list({ eventType: 'product.listed' });
    const payload = events[0]?.payload as {
      externalContentId: string;
      externalProductId: string;
      channel: string;
    };
    expect(payload.externalContentId).toBe(listed.externalContentId);
    expect(payload.externalProductId).toBe(listed.externalProductId);

    const stored = await services.products.getProduct(product.id);
    expect(stored.status).toBe('listed');
    expect(stored.externalRef).toBe(listed.externalProductId);
  });
});
