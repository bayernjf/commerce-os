import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

describe('inventory/fulfillment/payment placeholders (T-M3-09)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => teardownHarness(h));

  it('maintains inventory manually (upsert + list)', async () => {
    const product = await h.services.products.createProduct({
      title: 'p',
      skus: [{ skuCode: 'SKU-DEMO-001', price: 1299 }],
    });
    const skuId = product.skus[0]!.id;
    const row = await h.services.fulfillment.setInventory(skuId, 10);
    expect(row.qtyAvailable).toBe(10);
    const updated = await h.services.fulfillment.setInventory(skuId, 3);
    expect(updated.id).toBe(row.id);
    expect(updated.qtyAvailable).toBe(3);
    expect((await h.services.fulfillment.listInventory())[0]?.qtyAvailable).toBe(3);
  });

  it('rejects negative/non-integer quantities', async () => {
    const product = await h.services.products.createProduct({ title: 'p', skus: [{ skuCode: 'S', price: 1 }] });
    await expect(h.services.fulfillment.setInventory(product.skus[0]!.id, -2)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('fulfillment and payment are visible 501 placeholders, never fake success', () => {
    try {
      h.services.fulfillment.placeholderShip();
      throw new Error('ship should throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('NOT_IMPLEMENTED_PLACEHOLDER');
    }
    try {
      h.services.fulfillment.placeholderPay();
      throw new Error('pay should throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('NOT_IMPLEMENTED_PLACEHOLDER');
    }
  });
});
