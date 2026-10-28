/**
 * Payment gateway port (SF-05, Tier0-独立站双用 v1.0 §5.3).
 * External payment adapter abstraction: like ChannelAdapter, the port only
 * talks to the gateway side and never owns local persistence — the checkout
 * service records payment rows in the payments table (migration 003).
 */

export type PaymentStatus = 'created' | 'confirmed' | 'failed' | 'refunded';

export interface PaymentGatewayIntent {
  paymentId: string;
  provider: string;
  status: PaymentStatus;
  externalRef?: string;
  amountMicros: number;
  currency: string;
}

export interface CreatePaymentInput {
  paymentId: string;
  amountMicros: number;
  currency: string;
}

export interface PaymentPort {
  readonly provider: string;
  create(input: CreatePaymentInput): Promise<PaymentGatewayIntent>;
  confirm(paymentId: string): Promise<PaymentGatewayIntent>;
  refund(paymentId: string, amountMicros: number): Promise<PaymentGatewayIntent>;
  getStatus(paymentId: string): Promise<PaymentGatewayIntent>;
  /** Verify a gateway webhook delivery. Fake provider has no signature; the real Stripe adapter (LF-07) does HMAC. */
  verifyWebhook(signature: string, payload: string, secret: string): Promise<boolean>;
}
