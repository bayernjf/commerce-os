import { CommerceError } from '../util/errors.js';
import type { CreatePaymentInput, PaymentGatewayIntent, PaymentPort } from './payment-port.js';

/**
 * Deterministic offline payment provider (SF-05). Never opens a network
 * connection; success/failure/refund paths are scripted, mirroring the
 * sandbox-douyin fixtures approach. A real Stripe adapter (LF-07) replaces
 * this once credentials exist; until then nothing silently falls back to fake.
 */

export interface FakePaymentScript {
  /** Payment ids whose confirm() fails. */
  failConfirmPaymentIds?: string[];
  /** Confirm() fails when the intent amount exceeds this micros threshold. */
  failConfirmAmountAboveMicros?: number;
}

function notFoundError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('NOT_FOUND', message, false, details);
}
function validationError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('VALIDATION_FAILED', message, false, details);
}

export class FakePaymentProvider implements PaymentPort {
  readonly provider = 'fake';
  readonly sandbox = true;
  private readonly state = new Map<string, PaymentGatewayIntent>();

  constructor(private readonly script: FakePaymentScript = {}) {}

  async create(input: CreatePaymentInput): Promise<PaymentGatewayIntent> {
    if (!input.paymentId?.trim()) throw validationError('paymentId is required');
    if (!Number.isInteger(input.amountMicros) || input.amountMicros <= 0) {
      throw validationError(`amountMicros must be a positive integer: ${input.amountMicros}`);
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) throw validationError(`currency must be ISO 4217: ${input.currency}`);
    if (this.state.has(input.paymentId)) {
      throw validationError(`payment already exists: ${input.paymentId}`, { paymentId: input.paymentId });
    }
    const intent: PaymentGatewayIntent = {
      paymentId: input.paymentId,
      provider: this.provider,
      status: 'created',
      externalRef: `fake_${input.paymentId}`,
      amountMicros: input.amountMicros,
      currency: input.currency,
    };
    this.state.set(input.paymentId, intent);
    return intent;
  }

  async confirm(paymentId: string): Promise<PaymentGatewayIntent> {
    const current = this.require(paymentId);
    if (current.status !== 'created') {
      throw validationError(`payment not confirmable from ${current.status}`, { paymentId, status: current.status });
    }
    const fail =
      this.script.failConfirmPaymentIds?.includes(paymentId) ??
      false;
    const failAmount =
      this.script.failConfirmAmountAboveMicros !== undefined &&
      current.amountMicros > this.script.failConfirmAmountAboveMicros;
    const status: PaymentGatewayIntent['status'] = fail || failAmount ? 'failed' : 'confirmed';
    const next = { ...current, status };
    this.state.set(paymentId, next);
    return next;
  }

  async refund(paymentId: string, amountMicros: number): Promise<PaymentGatewayIntent> {
    const current = this.require(paymentId);
    if (current.status !== 'confirmed') {
      throw validationError(`payment not refundable from ${current.status}`, { paymentId, status: current.status });
    }
    if (!Number.isInteger(amountMicros) || amountMicros <= 0 || amountMicros > current.amountMicros) {
      throw validationError(`refund amount out of range: ${amountMicros}`, { paymentId, amountMicros });
    }
    const next = { ...current, status: 'refunded' as const };
    this.state.set(paymentId, next);
    return next;
  }

  async getStatus(paymentId: string): Promise<PaymentGatewayIntent> {
    return this.require(paymentId);
  }

  async verifyWebhook(_signature: string, _payload: string, _secret: string): Promise<boolean> {
    // Fake gateway has no signature scheme; real HMAC verification lands with
    // the Stripe adapter (LF-07) / webhook slice (SF-07).
    return true;
  }

  private require(paymentId: string): PaymentGatewayIntent {
    const intent = this.state.get(paymentId);
    if (!intent) throw notFoundError(`payment not found: ${paymentId}`, { paymentId });
    return intent;
  }
}
