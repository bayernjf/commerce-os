import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

describe('after-sale refund flow (T-M3-08)', () => {
  let h: TestHarness;
  let orderId: string;

  beforeEach(async () => {
    h = await setupHarness();
    const account = await h.services.accounts.create({ channel: 'sandbox-douyin', displayName: 'shop' });
    const imported = await h.services.orders.importFromChannel(account.id);
    orderId = imported.imported[0]!.id;
  });
  afterEach(async () => teardownHarness(h));

  it('a 1200 CNY refund is held (D2) and nothing reaches the channel before approval', async () => {
    const order = await h.services.orders.getOrder(orderId);
    const refund = await h.services.aftersales.requestRefund(orderId, {
      lines: [{ orderItemId: order.lines[0]!.id, qty: 1 }],
      reason: '商品瑕疵',
    });
    expect(refund.status).toBe('awaiting_approval');
    expect(refund.decisionId).toBeTruthy();
    expect(refund.externalRefundRef).toBeUndefined();

    const events = await h.services.events.list({ refType: 'refund', refId: refund.id });
    expect(events.some((e) => e.eventType === 'decision.requested')).toBe(true);
    expect(events.some((e) => e.eventType === 'refund.awaiting_approval')).toBe(true);
  });

  it('refund amount is computed from stored order lines, never from client input', async () => {
    const order = await h.services.orders.getOrder(orderId);
    const refund = await h.services.aftersales.requestRefund(orderId, {
      lines: [{ orderItemId: order.lines[0]!.id, qty: 1, amount: 0.01 }],
      reason: 'x',
    });
    expect(refund.lines[0]?.amount).toBe(1299);
  });

  it('approving the held refund executes the channel refund and records succeeded', async () => {
    const order = await h.services.orders.getOrder(orderId);
    const held = await h.services.aftersales.requestRefund(orderId, {
      lines: [{ orderItemId: order.lines[0]!.id }],
      reason: '七天无理由',
    });
    const succeeded = await h.services.aftersales.decideRefund(held.id, 'approve', 'tester', '同意');
    expect(succeeded.status).toBe('succeeded');
    expect(succeeded.externalRefundRef).toBe('DY-SB-REFUND-5001');

    const events = await h.services.events.list({ refType: 'refund', refId: held.id });
    expect(events.some((e) => e.eventType === 'refund.succeeded')).toBe(true);
  });

  it('rejecting the held refund leaves no channel call and records rejected', async () => {
    const order = await h.services.orders.getOrder(orderId);
    const held = await h.services.aftersales.requestRefund(orderId, {
      lines: [{ orderItemId: order.lines[0]!.id }],
      reason: 'x',
    });
    const rejected = await h.services.aftersales.decideRefund(held.id, 'reject', 'tester', '不符合');
    expect(rejected.status).toBe('rejected');
    expect(rejected.externalRefundRef).toBeUndefined();

    const events = await h.services.events.list({ refType: 'refund', refId: held.id });
    expect(events.some((e) => e.eventType === 'refund.succeeded')).toBe(false);
    expect(events.some((e) => e.eventType === 'refund.rejected')).toBe(true);
  });

  it('cannot decide a refund that is not awaiting approval', async () => {
    const order = await h.services.orders.getOrder(orderId);
    const held = await h.services.aftersales.requestRefund(orderId, {
      lines: [{ orderItemId: order.lines[0]!.id }],
      reason: 'x',
    });
    await h.services.aftersales.decideRefund(held.id, 'approve', 'tester');
    await expect(
      h.services.aftersales.decideRefund(held.id, 'approve', 'tester'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
