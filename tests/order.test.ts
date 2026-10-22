import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

describe('order center (T-M3-05)', () => {
  let h: TestHarness;
  let accountId: string;

  beforeEach(async () => {
    h = await setupHarness();
    const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: 'sandbox shop' });
    accountId = account.id;
  });
  afterEach(async () => teardownHarness(h));

  it('imports paid orders from the channel and maps lines', async () => {
    const result = await h.services.orders.importFromChannel(accountId);
    expect(result.imported).toHaveLength(1);
    const order = result.imported[0]!;
    expect(order.status).toBe('paid');
    expect(order.totalAmount).toBe(1299);
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]?.externalSkuCode).toBe('SKU-DEMO-001');

    const stored = await h.services.orders.getOrder(order.id);
    expect(stored.externalOrderId).toBe('DY-SB-20261022-0001');
  });

  it('re-importing the same orders is idempotent (skipped, never duplicated)', async () => {
    const first = await h.services.orders.importFromChannel(accountId);
    expect(first.imported).toHaveLength(1);
    const second = await h.services.orders.importFromChannel(accountId);
    expect(second.imported).toHaveLength(0);
    expect(second.skipped[0]).toMatchObject({ externalOrderId: 'DY-SB-20261022-0001', reason: expect.stringContaining('idempotent') });
    expect(await h.services.orders.listOrders()).toHaveLength(1);
  });

  it('unknown channel account fails closed', async () => {
    await expect(h.services.orders.importFromChannel('acc_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
