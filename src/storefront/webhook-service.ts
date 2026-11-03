import { createHmac, timingSafeEqual } from 'node:crypto';
import type { StorageDriver } from '../storage/driver.js';
import type { EventLog } from '../storage/event-log.js';
import { CommerceError, isUniqueViolation } from '../util/errors.js';
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
      await this.recordRejected(input, raw);
      throw signatureInvalidError();
    }

    const existing = await this.driver.get<Record<string, unknown>>(
      // Only a processed delivery occupies the deliveryId: a rejected record is
      // an audit trail, not a dedup marker — otherwise a bad-signature request
      // could squat a deliveryId and the gateway's legitimate retry would be
      // swallowed as a duplicate forever (review 2026-11-02 P2-2).
      "SELECT id FROM webhook_deliveries WHERE provider = ? AND delivery_id = ? AND status = 'processed'",
      [input.provider, input.deliveryId],
    );
    if (existing) return { status: 'duplicate', deliveryId: input.deliveryId };

    if (!(await this.claimDelivery(input, raw))) {
      // A concurrent verified delivery won the row between the check and here.
      return { status: 'duplicate', deliveryId: input.deliveryId };
    }
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

  /**
   * Audit a rejected delivery. The (provider, delivery_id) unique key means a
   * repeat bad-signature attempt cannot be recorded twice — the first row is
   * kept and the duplicate insert is simply skipped.
   */
  private async recordRejected(input: HandleDeliveryInput, raw: string): Promise<void> {
    try {
      await this.driver.run(
        `INSERT INTO webhook_deliveries (id, provider, delivery_id, payment_id, status, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId('whk'), input.provider, input.deliveryId, input.paymentId ?? null, 'rejected', raw, nowIso()],
      );
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
  }

  /**
   * Take ownership of the (provider, deliveryId) row for a verified delivery:
   * upgrade a squatting rejected row in place, or insert fresh. False means a
   * concurrent delivery already owns the row.
   */
  private async claimDelivery(input: HandleDeliveryInput, raw: string): Promise<boolean> {
    const upgraded = await this.driver.run(
      `UPDATE webhook_deliveries SET status = 'processed', payment_id = ?, raw_json = ?
       WHERE provider = ? AND delivery_id = ? AND status = 'rejected'`,
      [input.paymentId ?? null, raw, input.provider, input.deliveryId],
    );
    if (upgraded.changes > 0) return true;
    try {
      await this.driver.run(
        `INSERT INTO webhook_deliveries (id, provider, delivery_id, payment_id, status, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId('whk'), input.provider, input.deliveryId, input.paymentId ?? null, 'processed', raw, nowIso()],
      );
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
