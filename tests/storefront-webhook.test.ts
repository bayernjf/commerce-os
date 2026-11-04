import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { EventLog } from '../src/storage/event-log.js';
import { WebhookService, signPayload } from '../src/storefront/webhook-service.js';

describe('payment webhook receiver (SF-07)', () => {
  let driver: SqliteDriver;
  let events: EventLog;
  let webhooks: WebhookService;

  beforeEach(async () => {
    driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    events = new EventLog(driver);
    webhooks = new WebhookService(driver, events);
  });
  afterEach(async () => driver.close());

  const secret = 'test-secret';
  const payload = { type: 'payment.confirmed', paymentId: 'pay_1', amountMicros: 1000 };

  function envelopeRaw(fields: Record<string, unknown>): string {
    return JSON.stringify({ deliveryId: 'del_1', paymentId: 'pay_1', payload, ...fields });
  }

  function signedInput(rawBody: string, overrides: Record<string, unknown> = {}) {
    return { provider: 'fake', secret, signature: signPayload(rawBody, secret), rawBody, ...overrides };
  }

  it('processes a verified delivery, records it and emits an audit event', async () => {
    const rawBody = envelopeRaw({ deliveryId: 'del_1' });
    const result = await webhooks.handleDelivery(signedInput(rawBody));
    expect(result).toEqual({ status: 'processed', deliveryId: 'del_1' });

    const row = await driver.get<Record<string, unknown>>('SELECT * FROM webhook_deliveries WHERE delivery_id = ?', ['del_1']);
    expect(row?.status).toBe('processed');
    expect(row?.raw_json).toBe(rawBody);

    const evs = await events.list({ eventType: 'payment.webhook_delivered' });
    expect(evs).toHaveLength(1);
    expect(evs[0]?.refId).toBe('pay_1');
  });

  it('rejects a bad signature with 401 and records the rejected delivery', async () => {
    const rawBody = envelopeRaw({ deliveryId: 'del_bad' });
    await expect(
      webhooks.handleDelivery(signedInput(rawBody, { signature: 'deadbeef' })),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });

    const row = await driver.get<Record<string, unknown>>('SELECT * FROM webhook_deliveries WHERE delivery_id = ?', ['del_bad']);
    expect(row?.status).toBe('rejected');
    const evs = await events.list({ eventType: 'payment.webhook_delivered' });
    expect(evs).toHaveLength(0);
  });

  it('acknowledges duplicate deliveries without reprocessing', async () => {
    const rawBody = envelopeRaw({ deliveryId: 'del_2' });
    const first = await webhooks.handleDelivery(signedInput(rawBody));
    expect(first.status).toBe('processed');

    const second = await webhooks.handleDelivery(signedInput(rawBody));
    expect(second.status).toBe('duplicate');

    const rows = await driver.all('SELECT id FROM webhook_deliveries WHERE delivery_id = ?', ['del_2']);
    expect(rows).toHaveLength(1);
    const evs = await events.list({ eventType: 'payment.webhook_delivered' });
    expect(evs).toHaveLength(1);
  });

  it('rejects missing required fields', async () => {
    const rawBody = envelopeRaw({ deliveryId: 'del_3' });
    await expect(
      webhooks.handleDelivery(signedInput(rawBody, { provider: '' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      webhooks.handleDelivery(signedInput(rawBody, { secret: '' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // A verified body without deliveryId/payload is a validation error, not a 401.
    const noDelivery = JSON.stringify({ paymentId: 'pay_1', payload });
    await expect(
      webhooks.handleDelivery(signedInput(noDelivery)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('verifies the signature over the exact body bytes, not a re-serialization (P2-3)', async () => {
    // Unusual but valid formatting that JSON.stringify would normalize away:
    // whitespace and a different key order must still verify when the sender
    // signed exactly these bytes.
    const rawBody = '{ "payload" : { "b": 2, "a": 1 }, "deliveryId" : "del_raw", "paymentId": "pay_1" }';
    const ok = await webhooks.handleDelivery(signedInput(rawBody));
    expect(ok.status).toBe('processed');

    // And the reverse: a signature computed over the canonical
    // re-serialization must fail when the actual bytes differ.
    const sent = '{ "payload": { "a": 1, "b": 2 }, "deliveryId": "del_raw2", "paymentId": "pay_1" }';
    const canonical = JSON.stringify({ deliveryId: 'del_raw2', paymentId: 'pay_1', payload: { a: 1, b: 2 } });
    await expect(
      webhooks.handleDelivery(signedInput(sent, { signature: signPayload(canonical, secret) })),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
  });

  it('does not let a rejected delivery squat the deliveryId (P2-2)', async () => {
    // Attacker squats the id with a bad signature...
    const rawBody = envelopeRaw({ deliveryId: 'del_squat' });
    await expect(
      webhooks.handleDelivery(signedInput(rawBody, { signature: 'deadbeef' })),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    // ...and the gateway's legitimate retry is still processed, not deduped.
    const retried = await webhooks.handleDelivery(signedInput(rawBody));
    expect(retried.status).toBe('processed');
    const row = await driver.get<Record<string, unknown>>('SELECT status FROM webhook_deliveries WHERE delivery_id = ?', ['del_squat']);
    expect(row?.status).toBe('processed');
    // The claimed id dedupes normally afterwards.
    const again = await webhooks.handleDelivery(signedInput(rawBody));
    expect(again.status).toBe('duplicate');
  });

  it('keeps only the first rejected audit row for repeated bad signatures', async () => {
    const rawBody = envelopeRaw({ deliveryId: 'del_spam', paymentId: undefined });
    for (let i = 0; i < 2; i += 1) {
      await expect(
        webhooks.handleDelivery(signedInput(rawBody, { signature: 'deadbeef' })),
      ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    }
    const rows = await driver.all('SELECT * FROM webhook_deliveries WHERE delivery_id = ?', ['del_spam']);
    expect(rows).toHaveLength(1);
  });

  it('prunes rejected rows outside the retention window without touching recent or processed rows', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const oldIso = new Date(Date.now() - 60 * DAY_MS).toISOString();
    const recentIso = new Date(Date.now() - 1 * DAY_MS).toISOString();
    const insert = (id: string, deliveryId: string, status: string, createdAt: string) =>
      driver.run(
        `INSERT INTO webhook_deliveries (id, provider, delivery_id, payment_id, status, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, 'fake', deliveryId, null, status, '{}', createdAt],
      );
    await insert('whk_old', 'del_old', 'rejected', oldIso);
    await insert('whk_recent', 'del_recent', 'rejected', recentIso);
    // Processed payloads are dedup markers: they must never be pruned.
    await insert('whk_proc_old', 'del_proc_old', 'processed', oldIso);

    // A fresh bad-signature delivery runs the prune pass.
    const rawBody = envelopeRaw({ deliveryId: 'del_new' });
    await expect(
      webhooks.handleDelivery(signedInput(rawBody, { signature: 'deadbeef' })),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });

    expect(await driver.get('SELECT id FROM webhook_deliveries WHERE delivery_id = ?', ['del_old'])).toBeUndefined();
    expect(await driver.get('SELECT id FROM webhook_deliveries WHERE delivery_id = ?', ['del_recent'])).toBeDefined();
    expect(await driver.get('SELECT id FROM webhook_deliveries WHERE delivery_id = ?', ['del_proc_old'])).toBeDefined();
    expect(await driver.get('SELECT id FROM webhook_deliveries WHERE delivery_id = ?', ['del_new'])).toBeDefined();
  });
});
