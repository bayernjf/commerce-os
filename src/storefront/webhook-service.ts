import { createHmac, timingSafeEqual } from 'node:crypto';
import type { StorageDriver } from '../storage/driver.js';
import type { EventLog } from '../storage/event-log.js';
import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';

/**
 * Payment webhook receiver (SF-07, Tier0-独立站双用 v1.0 §5.3).
 * HMAC signature verification (401 on bad signature), delivery idempotency
 * via the webhook_deliveries table, and an audit event on first processing.
 * Duplicate deliveries are acknowledged without reprocessing.
 */

export interface WebhookDeliveryResult {
  status: 'processed' | 'duplicate';
  deliveryId: string;
}

export interface HandleDeliveryInput {
  provider: string;
  secret: string;
  deliveryId: string;
  paymentId?: string;
  payload: Record<string, unknown>;
  signature: string;
}

export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function signatureInvalidError(): CommerceError {
  return new CommerceError('WEBHOOK_SIGNATURE_INVALID', 'webhook signature verification failed', false);
}
function validationError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('VALIDATION_FAILED', message, false, details);
}

export class WebhookService {
  constructor(
    private readonly driver: StorageDriver,
    private readonly events?: EventLog,
  ) {}

  async handleDelivery(input: HandleDeliveryInput): Promise<WebhookDeliveryResult> {
    if (!input.provider?.trim() || !input.deliveryId?.trim() || !input.secret) {
      throw validationError('provider, deliveryId and secret are required');
    }
    const raw = JSON.stringify(input.payload ?? {});
    const expected = signPayload(raw, input.secret);
    const provided = String(input.signature ?? '');
    if (!safeEqual(expected, provided)) {
      await this.recordDelivery(input.provider, input.deliveryId, input.paymentId, 'rejected', raw);
      throw signatureInvalidError();
    }

    const existing = await this.driver.get<Record<string, unknown>>(
      'SELECT id FROM webhook_deliveries WHERE provider = ? AND delivery_id = ?',
      [input.provider, input.deliveryId],
    );
    if (existing) return { status: 'duplicate', deliveryId: input.deliveryId };

    await this.recordDelivery(input.provider, input.deliveryId, input.paymentId, 'processed', raw);
    if (this.events && input.paymentId) {
      await this.events.record({
        eventType: 'payment.webhook_delivered',
        refType: 'payment',
        refId: input.paymentId,
        payload: { provider: input.provider, deliveryId: input.deliveryId },
      });
    }
    return { status: 'processed', deliveryId: input.deliveryId };
  }

  private async recordDelivery(
    provider: string,
    deliveryId: string,
    paymentId: string | undefined,
    status: 'processed' | 'duplicate' | 'rejected',
    raw: string,
  ): Promise<void> {
    await this.driver.run(
      `INSERT INTO webhook_deliveries (id, provider, delivery_id, payment_id, status, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId('whk'), provider, deliveryId, paymentId ?? null, status, raw, nowIso()],
    );
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
