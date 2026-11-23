import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';
import { createApp } from '../src/server.js';
import { renderPrometheusMetrics } from '../src/observability/prometheus.js';
import { newId, nowIso } from '../src/util/ids.js';

describe('Prometheus metrics', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => teardownHarness(h));

  it('renders the dashboard snapshot as Prometheus text', async () => {
    const orderId = newId('ord');
    await h.driver.run(
      `INSERT INTO orders (id, channel, external_order_id, channel_account_id, status, total_amount, currency, buyer_ref, created_at, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, 'sandbox-douyin', `ext-${orderId}`, null, 'paid', 1299, 'CNY', null, nowIso(), nowIso()],
    );
    await h.driver.run(
      `INSERT INTO refunds (id, order_id, lines_json, reason, status, decision_id, external_refund_ref, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('rfd'), orderId, JSON.stringify([{ amount: 200 }]), 'test', 'succeeded', null, null, nowIso(), nowIso()],
    );
    await h.services.events.record({ eventType: 'product.listed', payload: {} });

    const text = renderPrometheusMetrics(await h.services.dashboard.getMetrics());
    expect(text).toContain('# TYPE commerce_up gauge');
    expect(text).toContain('commerce_orders{state="all"} 1');
    expect(text).toContain('commerce_orders{state="paid"} 1');
    expect(text).toContain('commerce_gross_amount{currency="CNY"} 1299');
    expect(text).toContain('commerce_refunds{state="succeeded"} 1');
    expect(text).toContain('commerce_refunded_amount{currency="CNY"} 200');
    expect(text).toContain('commerce_content_published 1');
    expect(text).toContain('commerce_net_amount{currency="CNY"} 1099');
  });

  it('serves /metrics without the ops bearer token', async () => {
    const app = createApp({ token: 'secret', services: h.services });
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('commerce_up 1');
  });
});
