import { describe, it, expect } from 'vitest';
import { SandboxDouyinAdapter } from '../src/channel/adapters/sandbox-douyin.js';
import { CommerceError } from '../src/util/errors.js';

describe('sandbox-douyin adapter (T-M3-04)', () => {
  it('is offline and replays recorded fixtures', async () => {
    const adapter = new SandboxDouyinAdapter();
    expect(adapter.sandbox).toBe(true);
    expect(adapter.channel).toBe('sandbox-douyin');

    const orders = await adapter.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.externalOrderId).toBe('DY-SB-20261022-0001');
    expect(orders[0]?.status).toBe('paid');
    expect(orders[0]?.totalAmount).toBe(1299);

    const inventory = await adapter.getInventory(['SKU-DEMO-001']);
    expect(inventory[0]?.qtyAvailable).toBe(42);
  });

  it('filters orders by since', async () => {
    const adapter = new SandboxDouyinAdapter();
    expect(await adapter.listOrders({ since: '2027-01-01T00:00:00.000Z' })).toHaveLength(0);
    expect(await adapter.listOrders({ since: '2026-01-01T00:00:00.000Z' })).toHaveLength(1);
  });

  it('upserts products with deterministic recorded ids', async () => {
    const adapter = new SandboxDouyinAdapter();
    const ref = await adapter.upsertProduct({
      title: '演示商品',
      skus: [{ skuCode: 'SKU-DEMO-001', specs: {}, price: 1299, currency: 'CNY' }],
    });
    expect(ref.externalProductId).toBe('dy-sandbox-prd-1001');
    expect(ref.externalSkuRefs[0]).toEqual({ skuCode: 'SKU-DEMO-001', externalSkuId: 'dy-sandbox-sku-1000' });
  });

  it('creates refunds only for recorded orders', async () => {
    const adapter = new SandboxDouyinAdapter();
    const result = await adapter.createRefund({
      externalOrderId: 'DY-SB-20261022-0001',
      lines: [{ externalSkuCode: 'SKU-DEMO-001', qty: 1, amount: 1299 }],
      reason: '七天无理由',
    });
    expect(result.status).toBe('accepted');
    expect(result.externalRefundId).toBe('DY-SB-REFUND-5001');

    await expect(
      adapter.createRefund({ externalOrderId: 'NOPE', lines: [], reason: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('publishes content with a recorded content id', async () => {
    const adapter = new SandboxDouyinAdapter();
    const result = await adapter.publish({ title: 't', body: {}, contentType: 'detail' });
    expect(result.status).toBe('published');
    expect(result.externalContentId).toBe('DY-SB-CONTENT-7001');
    expect(result.url).toContain('DY-SB-CONTENT-7001');
  });

  it('missing fixtures fail closed with CHANNEL_UNAVAILABLE', () => {
    try {
      new SandboxDouyinAdapter('/nonexistent/fixtures.json');
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CommerceError);
      expect((err as CommerceError).code).toBe('CHANNEL_UNAVAILABLE');
    }
  });
});
