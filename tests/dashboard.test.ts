import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';
import { createApp } from '../src/server.js';
import { newId, nowIso } from '../src/util/ids.js';

async function insertOrder(
  h: TestHarness,
  totalAmount: number,
  status = 'paid',
): Promise<string> {
  const id = newId('ord');
  await h.driver.run(
    `INSERT INTO orders (id, channel, external_order_id, channel_account_id, status, total_amount, currency, buyer_ref, created_at, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 'sandbox-douyin', `ext-${id}`, null, status, totalAmount, 'CNY', null, nowIso(), nowIso()],
  );
  return id;
}

describe('operating dashboard (T-M5-04)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => teardownHarness(h));

  it('returns zeroed metrics on an empty store', async () => {
    const m = await h.services.dashboard.getMetrics();
    expect(m.orders.total).toBe(0);
    expect(m.orders.grossAmount).toBe(0);
    expect(m.refunds.total).toBe(0);
    expect(m.refunds.refundedAmount).toBe(0);
    expect(m.content.published).toBe(0);
    expect(m.netAmount).toBe(0);
  });

  it('aggregates orders, succeeded refunds, published content and net', async () => {
    const orderId = await insertOrder(h, 1299);
    await insertOrder(h, 0, 'imported');

    // A succeeded refund with two lines totalling 200.
    await h.driver.run(
      `INSERT INTO refunds (id, order_id, lines_json, reason, status, decision_id, external_refund_ref, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('rfd'),
        orderId,
        JSON.stringify([
          { amount: 120 },
          { amount: 80 },
        ]),
        '七天无理由',
        'succeeded',
        null,
        null,
        nowIso(),
        nowIso(),
      ],
    );

    await h.services.events.record({ eventType: 'product.listed', payload: {} });

    const m = await h.services.dashboard.getMetrics();
    expect(m.orders.total).toBe(2);
    expect(m.orders.paid).toBe(1);
    expect(m.orders.grossAmount).toBe(1299);
    expect(m.refunds.total).toBe(1);
    expect(m.refunds.succeeded).toBe(1);
    expect(m.refunds.refundedAmount).toBe(200);
    expect(m.content.published).toBe(1);
    expect(m.netAmount).toBe(1099);
  });

  it('exposes metrics over GET /api/v1/dashboard', async () => {
    const app = createApp({ services: h.services });
    const res = await app.request('/api/v1/dashboard');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrics: { orders: { total: number }; currency: string };
    };
    expect(body.metrics.orders.total).toBe(0);
    expect(body.metrics.currency).toBe('CNY');
  });
});
