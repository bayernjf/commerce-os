import { describe, it, expect } from 'vitest';
import { FakePaymentProvider } from '../src/storefront/fake-payment-provider.js';
import { PaymentRegistry } from '../src/storefront/payment-registry.js';

describe('payment provider registry (SF-06)', () => {
  it('registers and resolves a configured provider', async () => {
    const registry = new PaymentRegistry();
    const fake = new FakePaymentProvider();
    registry.register(fake);
    expect(registry.has('fake')).toBe(true);
    expect(registry.get('fake')).toBe(fake);
    expect(registry.get('fake').sandbox).toBe(true);
    expect(registry.list()).toEqual(['fake']);
  });

  it('fails closed for unregistered providers and never falls back to fake', async () => {
    const registry = new PaymentRegistry();
    const fake = new FakePaymentProvider();
    registry.register(fake);

    expect(() => registry.get('stripe')).toThrowError(
      expect.objectContaining({
        code: 'CREDENTIAL_MISSING',
        details: expect.objectContaining({ provider: 'stripe', registered: ['fake'] }),
      }),
    );
    expect(() => registry.get('')).toThrowError(expect.objectContaining({ code: 'CREDENTIAL_MISSING' }));
    expect(registry.has('stripe')).toBe(false);
  });

  it('rejects duplicate registration', async () => {
    const registry = new PaymentRegistry();
    registry.register(new FakePaymentProvider());
    expect(() => registry.register(new FakePaymentProvider())).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });
});
