import type { PaymentPort } from './payment-port.js';
import { CommerceError } from '../util/errors.js';

/**
 * Payment provider registry (SF-06). Providers register only once configured;
 * an unregistered name fails closed with CREDENTIAL_MISSING — the checkout
 * flow never silently falls back to a fake provider (不静默回退 fake).
 */
export class PaymentRegistry {
  private readonly providers = new Map<string, PaymentPort>();

  register(provider: PaymentPort): void {
    if (this.providers.has(provider.provider)) {
      throw new CommerceError('CONFLICT', `payment provider already registered: ${provider.provider}`);
    }
    this.providers.set(provider.provider, provider);
  }

  get(provider: string): PaymentPort {
    const port = this.providers.get(provider);
    if (!port) {
      throw new CommerceError(
        'CREDENTIAL_MISSING',
        `no payment provider registered for '${provider}'; configure credentials before use (never falls back to fake)`,
        false,
        { provider, registered: this.list() },
      );
    }
    return port;
  }

  has(provider: string): boolean {
    return this.providers.has(provider);
  }

  list(): string[] {
    return [...this.providers.keys()].sort();
  }
}
