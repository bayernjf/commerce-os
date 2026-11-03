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
  /** Hex HMAC-SHA256 over the exact request body bytes (x-signature header). */
  signature: string;
  /** The request body exactly as received — never a re-serialized object. */
  rawBody: string;
}

interface WebhookEnvelope {
  deliveryId?: string;
  paymentId?: string;
  payload?: Record<string, unknown>;
}

/** Best-effort envelope parse; null for non-JSON or non-object bodies. */
function parseEnvelope(rawBody: string): WebhookEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    const envelope: WebhookEnvelope = {};
    if (typeof body.deliveryId === 'string') envelope.deliveryId = body.deliveryId;
    if (typeof body.paymentId === 'string') envelope.paymentId = body.paymentId;
    if (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) {
      envelope.payload = body.payload as Record<string, unknown>;
    }
    return envelope;
  } catch {
    return null;
  }
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
    if (!input.provider?.trim() || !input.secret) {
      throw validationError('provider and secret are required');
    }
    // Verify over the exact bytes received (P2-3): re-serializing a parsed
    // object would make the signature depend on key order, whitespace and
    // number spellings, and could never interoperate with a gateway that
    // signs the raw payload it sent.
    const expected = signPayload(input.rawBody, input.secret);
    const provided = String(input.signature ?? '');
    if (!provided || !safeEqual(expected, provided)) {
      const meta = parseEnvelope(input.rawBody);
      await this.recordRejected(input.provider, meta?.deliveryId ?? '', meta?.paymentId ?? null, input.rawBody);
      throw signatureInvalidError();
    }
    const envelope = parseEnvelope(input.rawBody);
    if (!envelope?.deliveryId?.trim() || !envelope.payload) {
      throw validationError('deliveryId and payload are required');
    }
    const deliveryId = envelope.deliveryId;
    const paymentId = envelope.paymentId ?? null;

    const existing = await this.driver.get<Record<string, unknown>>(
      // Only a processed delivery occupies the deliveryId: a rejected record is
      // an audit trail, not a dedup marker — otherwise a bad-signature request
      // could squat a deliveryId and the gateway's legitimate retry would be
      // swallowed as a duplicate forever (review 2026-11-02 P2-2).
      "SELECT id FROM webhook_deliveries WHERE provider = ? AND delivery_id = ? AND status = 'processed'",
      [input.provider, deliveryId],
    );
    if (existing) return { status: 'duplicate', deliveryId };

    if (!(await this.claimDelivery(input.provider, deliveryId, paymentId, input.rawBody))) {
      // A concurrent verified delivery won the row between the check and here.
      return { status: 'duplicate', deliveryId };
    }
    if (this.events && paymentId) {
      await this.events.record({
        eventType: 'payment.webhook_delivered',
        refType: 'payment',
        refId: paymentId,
        payload: { provider: input.provider, deliveryId },
      });
    }
    return { status: 'processed', deliveryId };
  }

  /**
   * Audit a rejected delivery. The (provider, delivery_id) unique key means a
   * repeat bad-signature attempt cannot be recorded twice — the first row is
   * kept and the duplicate insert is simply skipped.
   */
  private async recordRejected(provider: string, deliveryId: string, paymentId: string | null, raw: string): Promise<void> {
    try {
      await this.driver.run(
        `INSERT INTO webhook_deliveries (id, provider, delivery_id, payment_id, status, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId('whk'), provider, deliveryId, paymentId, 'rejected', raw, nowIso()],
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
  private async claimDelivery(provider: string, deliveryId: string, paymentId: string | null, raw: string): Promise<boolean> {
    const upgraded = await this.driver.run(
      `UPDATE webhook_deliveries SET status = 'processed', payment_id = ?, raw_json = ?
       WHERE provider = ? AND delivery_id = ? AND status = 'rejected'`,
      [paymentId, raw, provider, deliveryId],
    );
    if (upgraded.changes > 0) return true;
    try {
      await this.driver.run(
        `INSERT INTO webhook_deliveries (id, provider, delivery_id, payment_id, status, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId('whk'), provider, deliveryId, paymentId, 'processed', raw, nowIso()],
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
