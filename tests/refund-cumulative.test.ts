import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

/**
 * P1 regression: the same order line used to be refundable forever (money-out
 * amplified per request once a real payment channel lands). These tests pin
 * the cumulative guard, idempotent replay, and single-claim approval — with
 * real concurrency against a real database, no mocks.
 */

async function createOrder(h: TestHarness, line: { qty: number; price: number }) {
  const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: 'shop' });
  const orderId = `ord-${Math.random().toString(36).slice(2, 10)}`;
  const itemId = `${orderId}-item-1`;
  const now = new Date().toISOString();
  await h.driver.run(
    `INSERT INTO orders (id, channel, external_order_id, channel_account_id, status, total_amount, currency, buyer_ref, created_at, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, 'sandbox-douyin', `ext-${orderId}`, account.id, 'paid', line.qty * line.price, 'CNY', 'buyer', now, now],
  );
  await h.driver.run(
    `INSERT INTO order_items (id, order_id, sku_id, external_sku_code, title, qty, price)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [itemId, orderId, null, 'SKU-X', '累计退款测试商品', line.qty, line.price],
  );
  return { orderId, itemId };
}

async function usageRow(h: TestHarness, itemId: string) {
  return h.driver.get<{ refunded_qty: number; refunded_amount_cents: number }>(
    'SELECT refunded_qty, refunded_amount_cents FROM refund_line_usage WHERE order_item_id = ?',
    [itemId],
  );
}

describe('cumulative refund guard (P1)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => teardownHarness(h));

  it('serial partial refunds accumulate; the one over the cap is rejected and audited', async () => {
    const { orderId, itemId } = await createOrder(h, { qty: 5, price: 1000 });
    const request = () =>
      h.services.aftersales.requestRefund(orderId, { lines: [{ orderItemId: itemId, qty: 1 }], reason: '串行部分退' });

    // qty 5 × 1000 each: every request is D2-held, reservations stack 1..5.
    for (let i = 0; i < 5; i += 1) {
      const refund = await request();
      expect(refund.status).toBe('awaiting_approval');
    }
    expect((await usageRow(h, itemId))?.refunded_qty).toBe(5);

    await expect(request()).rejects.toThrowError(/exceeds refundable quantity/);
    expect((await usageRow(h, itemId))?.refunded_qty).toBe(5);

    const events = await h.services.events.list({ refType: 'refund' });
    expect(events.some((e) => e.eventType === 'refund.limit_exceeded')).toBe(true);
  });

  it('a fully refunded line rejects any further refund (real channel, real fixture order)', async () => {
    const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: 'shop' });
    const imported = await h.services.orders.importFromChannel(account.id);
    const orderId = imported.imported[0]!.id;
    const order = await h.services.orders.getOrder(orderId);
    const itemId = order.lines[0]!.id; // fixture: qty 1 × 1299 CNY

    const held = await h.services.aftersales.requestRefund(orderId, {
      lines: [{ orderItemId: itemId, qty: 1 }],
      reason: '全退',
    });
    const succeeded = await h.services.aftersales.decideRefund(held.id, 'approve', 'tester');
    expect(succeeded.status).toBe('succeeded');

    await expect(
      h.services.aftersales.requestRefund(orderId, { lines: [{ orderItemId: itemId, qty: 1 }], reason: '再退' }),
    ).rejects.toThrowError(/exceeds refundable quantity/);
  });

  it('two concurrent requests on the same line: exactly one succeeds', async () => {
    const { orderId, itemId } = await createOrder(h, { qty: 2, price: 1000 });
    const request = () =>
      h.services.aftersales.requestRefund(orderId, { lines: [{ orderItemId: itemId, qty: 2 }], reason: '并发重复' });

    const results = await Promise.allSettled([request(), request()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/exceeds refundable quantity/);
    expect((await usageRow(h, itemId))?.refunded_qty).toBe(2);
  });

  it('two concurrent requests on a qty-1 line: exactly one is admitted', async () => {
    // The admission gate sits upstream of the zeus decision, so it binds the
    // small auto-approve path (D0/D1 inline settle) exactly the same way.
    const { orderId, itemId } = await createOrder(h, { qty: 1, price: 100 });
    const request = () =>
      h.services.aftersales.requestRefund(orderId, { lines: [{ orderItemId: itemId, qty: 1 }], reason: '小额并发' });

    const results = await Promise.allSettled([request(), request()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await usageRow(h, itemId))?.refunded_qty).toBe(1);

    const refunds = await h.services.aftersales.listRefundsForOrder(orderId);
    expect(refunds).toHaveLength(1);
  });

  it('replayed idempotency key returns the original refund without paying twice', async () => {
    const { orderId, itemId } = await createOrder(h, { qty: 3, price: 100 });
    const request = () =>
      h.services.aftersales.requestRefund(orderId, {
        lines: [{ orderItemId: itemId, qty: 1 }],
        reason: '幂等重复投递',
        idempotencyKey: 'retry-key-1',
      });

    const first = await request();
    const replay = await request();
    expect(replay.id).toBe(first.id);
    expect((await h.services.aftersales.listRefundsForOrder(orderId))).toHaveLength(1);
    expect((await usageRow(h, itemId))?.refunded_qty).toBe(1);
  });

  it('concurrent approvals claim the refund exactly once (real channel)', async () => {
    const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: 'shop' });
    const imported = await h.services.orders.importFromChannel(account.id);
    const orderId = imported.imported[0]!.id;
    const order = await h.services.orders.getOrder(orderId);

    const held = await h.services.aftersales.requestRefund(orderId, {
      lines: [{ orderItemId: order.lines[0]!.id, qty: 1 }],
      reason: '并发审批',
    });
    expect(held.status).toBe('awaiting_approval');

    const results = await Promise.allSettled([
      h.services.aftersales.decideRefund(held.id, 'approve', 'approver-a'),
      h.services.aftersales.decideRefund(held.id, 'approve', 'approver-b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await h.services.aftersales.getRefund(held.id)).status).toBe('succeeded');
  });

  it('rejection releases the reservation so a later refund can use it', async () => {
    const { orderId, itemId } = await createOrder(h, { qty: 2, price: 1000 });
    const held = await h.services.aftersales.requestRefund(orderId, {
      lines: [{ orderItemId: itemId, qty: 2 }],
      reason: '将被驳回',
    });
    expect((await usageRow(h, itemId))?.refunded_qty).toBe(2);

    await h.services.aftersales.decideRefund(held.id, 'reject', 'tester', '不符合政策');
    expect((await usageRow(h, itemId))?.refunded_qty).toBe(0);

    const again = await h.services.aftersales.requestRefund(orderId, {
      lines: [{ orderItemId: itemId, qty: 2 }],
      reason: '驳回后重新申请',
    });
    expect(again.status).toBe('awaiting_approval');
    expect((await usageRow(h, itemId))?.refunded_qty).toBe(2);
  });
});
