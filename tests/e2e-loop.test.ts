import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

/**
 * GATE-M3: one end-to-end commerce loop, no external credentials.
 *
 *  product (SKU-DEMO-001)
 *    → stub content candidate
 *    → publish decision (D3, external) held
 *    → human approval
 *    → sandbox upsertProduct + publish (product listed)
 *    → sandbox order pull (paid, 1299 CNY, idempotent)
 *    → refund decision (D2, 1299 CNY) held
 *    → human approval
 *    → sandbox refund succeeded
 *
 * Every key step is asserted in the commerce_events audit trail and in
 * zeus decision ids.
 */
describe('GATE-M3 end-to-end commerce loop', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => teardownHarness(h));

  it('runs product → listing(D3 approval) → order → refund(D2 approval) to success', async () => {
    // 1. sandbox channel account
    const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: '沙箱抖店' });
    expect(account.channel).toBe('sandbox-douyin');

    // 2. product with the SKU code present in the recorded order
    const product = await h.services.products.createProduct({
      title: '演示商品 标准款',
      channelAccountId: account.id,
      attributes: { brand: '演示' },
      skus: [{ skuCode: 'SKU-DEMO-001', specs: { model: 'standard' }, price: 1299, currency: 'CNY' }],
    });
    const skuId = product.skus[0]!.id;

    // 3. submit listing → stub content + D3 held
    const submitted = await h.services.publishing.submitListing({
      productId: product.id,
      channelAccountId: account.id,
      contentType: 'detail',
      sellingPoints: ['大容量', '一年质保'],
      constraints: { banned: ['第一', '全网最低'] },
    });
    expect(submitted.status).toBe('awaiting_approval');
    expect(submitted.grade).toBe('D3');
    expect(submitted.decisionId).toBeTruthy();
    const before = await h.services.products.getProduct(product.id);
    expect(before.status).toBe('draft');
    expect(before.externalRef).toBeUndefined();

    // 4. reject content-only forbidden words never appear; approval lists
    const listed = await h.services.publishing.approveListing(submitted.decisionId, 'owner', '可上架');
    expect(listed.status).toBe('listed');
    expect(listed.externalProductId).toBe('dy-sandbox-prd-1001');
    expect(listed.externalContentId).toBe('DY-SB-CONTENT-7001');
    const after = await h.services.products.getProduct(product.id);
    expect(after.status).toBe('listed');
    expect(after.externalRef).toBe('dy-sandbox-prd-1001');

    // 5. channel order pull (paid, idempotent)
    const imported = await h.services.orders.importFromChannel(account.id);
    expect(imported.imported).toHaveLength(1);
    const order = imported.imported[0]!;
    expect(order.status).toBe('paid');
    expect(order.totalAmount).toBe(1299);
    // the recorded SKU code resolves to the persisted SKU
    expect(order.lines[0]?.skuId).toBe(skuId);
    const again = await h.services.orders.importFromChannel(account.id);
    expect(again.imported).toHaveLength(0);

    // 6. inventory manual maintenance
    await h.services.fulfillment.setInventory(skuId, 42);
    expect((await h.services.fulfillment.listInventory())[0]?.qtyAvailable).toBe(42);

    // 7. refund 1299 → D2 held
    const refund = await h.services.aftersales.requestRefund(order.id, {
      lines: [{ orderItemId: order.lines[0]!.id }],
      reason: '七天无理由',
    });
    expect(refund.status).toBe('awaiting_approval');
    expect(refund.lines[0]?.amount).toBe(1299);
    expect(refund.externalRefundRef).toBeUndefined();

    // 8. approve → channel refund succeeds
    const succeeded = await h.services.aftersales.decideRefund(refund.id, 'approve', 'owner', '同意退款');
    expect(succeeded.status).toBe('succeeded');
    expect(succeeded.externalRefundRef).toBe('DY-SB-REFUND-5001');

    // 9. audit trail: every key step recorded
    const events = await h.services.events.list();
    const types = events.map((e) => e.eventType);
    expect(types).toEqual(
      expect.arrayContaining([
        'decision.requested',      // listing D3
        'product.listed',
        'order.imported',
        'decision.requested',      // refund D2
        'refund.awaiting_approval',
        'refund.succeeded',
      ]),
    );
    const decisionIds = events.filter((e) => e.decisionId).map((e) => e.decisionId as string);
    expect(new Set(decisionIds).size).toBe(2); // two distinct zeus decisions
    expect(decisionIds.every((id) => id.startsWith('dec_fake_'))).toBe(true);
  });

  it('listing rejection never touches the channel and keeps the product draft', async () => {
    const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: 'shop' });
    const product = await h.services.products.createProduct({
      title: 'p',
      channelAccountId: account.id,
      skus: [{ skuCode: 'SKU-DEMO-001', price: 1 }],
    });
    const submitted = await h.services.publishing.submitListing({
      productId: product.id,
      channelAccountId: account.id,
    });
    await h.services.publishing.rejectListing(submitted.decisionId, 'owner', '文案不行');
    const still = await h.services.products.getProduct(product.id);
    expect(still.status).toBe('draft');
    expect(still.externalRef).toBeUndefined();
  });
});
