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

  function validSignature(): string {
    return signPayload(JSON.stringify(payload), secret);
  }

  it('processes a verified delivery, records it and emits an audit event', async () => {
    const result = await webhooks.handleDelivery({
      provider: 'fake',
      secret,
      deliveryId: 'del_1',
      paymentId: 'pay_1',
      payload,
      signature: validSignature(),
    });
    expect(result).toEqual({ status: 'processed', deliveryId: 'del_1' });

    const row = await driver.get<Record<string, unknown>>('SELECT * FROM webhook_deliveries WHERE delivery_id = ?', ['del_1']);
    expect(row?.status).toBe('processed');

    const evs = await events.list({ eventType: 'payment.webhook_delivered' });
    expect(evs).toHaveLength(1);
    expect(evs[0]?.refId).toBe('pay_1');
  });

  it('rejects a bad signature with 401 and records the rejected delivery', async () => {
    await expect(
      webhooks.handleDelivery({ provider: 'fake', secret, deliveryId: 'del_bad', paymentId: 'pay_1', payload, signature: 'deadbeef' }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });

    const row = await driver.get<Record<string, unknown>>('SELECT * FROM webhook_deliveries WHERE delivery_id = ?', ['del_bad']);
    expect(row?.status).toBe('rejected');
    const evs = await events.list({ eventType: 'payment.webhook_delivered' });
    expect(evs).toHaveLength(0);
  });

  it('acknowledges duplicate deliveries without reprocessing', async () => {
    const first = await webhooks.handleDelivery({
      provider: 'fake',
      secret,
      deliveryId: 'del_2',
      paymentId: 'pay_1',
      payload,
      signature: validSignature(),
    });
    expect(first.status).toBe('processed');

    const second = await webhooks.handleDelivery({
      provider: 'fake',
      secret,
      deliveryId: 'del_2',
      paymentId: 'pay_1',
      payload,
      signature: validSignature(),
    });
    expect(second.status).toBe('duplicate');

    const rows = await driver.all('SELECT id FROM webhook_deliveries WHERE delivery_id = ?', ['del_2']);
    expect(rows).toHaveLength(1);
    const evs = await events.list({ eventType: 'payment.webhook_delivered' });
    expect(evs).toHaveLength(1);
  });

  it('rejects missing required fields', async () => {
    await expect(
      webhooks.handleDelivery({ provider: '', secret, deliveryId: 'del_3', payload, signature: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      webhooks.handleDelivery({ provider: 'fake', secret: '', deliveryId: 'del_3', payload, signature: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('does not let a rejected delivery squat the deliveryId (P2-2)', async () => {
    // Attacker squats the id with a bad signature...
    await expect(
      webhooks.handleDelivery({ provider: 'fake', secret, deliveryId: 'del_squat', paymentId: 'pay_1', payload, signature: 'deadbeef' }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    // ...and the gateway's legitimate retry is still processed, not deduped.
    const retried = await webhooks.handleDelivery({
      provider: 'fake', secret, deliveryId: 'del_squat', paymentId: 'pay_1', payload, signature: validSignature(),
    });
    expect(retried.status).toBe('processed');
    const row = await driver.get<Record<string, unknown>>('SELECT status FROM webhook_deliveries WHERE delivery_id = ?', ['del_squat']);
    expect(row?.status).toBe('processed');
    // The claimed id dedupes normally afterwards.
    const again = await webhooks.handleDelivery({
      provider: 'fake', secret, deliveryId: 'del_squat', paymentId: 'pay_1', payload, signature: validSignature(),
    });
    expect(again.status).toBe('duplicate');
  });

  it('keeps only the first rejected audit row for repeated bad signatures', async () => {
    for (let i = 0; i < 2; i += 1) {
      await expect(
        webhooks.handleDelivery({ provider: 'fake', secret, deliveryId: 'del_spam', payload, signature: 'deadbeef' }),
      ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    }
    const rows = await driver.all('SELECT * FROM webhook_deliveries WHERE delivery_id = ?', ['del_spam']);
    expect(rows).toHaveLength(1);
  });
});
