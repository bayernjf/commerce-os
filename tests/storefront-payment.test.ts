import { describe, it, expect } from 'vitest';
import { FakePaymentProvider } from '../src/storefront/fake-payment-provider.js';

describe('fake payment provider (SF-05)', () => {
  it('creates a created intent with deterministic external ref', async () => {
    const provider = new FakePaymentProvider();
    const intent = await provider.create({ paymentId: 'pay_1', amountMicros: 1299_000_000, currency: 'CNY' });
    expect(intent).toMatchObject({
      paymentId: 'pay_1',
      provider: 'fake',
      status: 'created',
      externalRef: 'fake_pay_1',
      amountMicros: 1299_000_000,
      currency: 'CNY',
    });
  });

  it('rejects bad create inputs and duplicates', async () => {
    const provider = new FakePaymentProvider();
    await expect(provider.create({ paymentId: ' ', amountMicros: 1, currency: 'CNY' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(provider.create({ paymentId: 'pay_2', amountMicros: 0, currency: 'CNY' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(provider.create({ paymentId: 'pay_3', amountMicros: 1, currency: 'cny' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await provider.create({ paymentId: 'pay_4', amountMicros: 1, currency: 'CNY' });
    await expect(provider.create({ paymentId: 'pay_4', amountMicros: 1, currency: 'CNY' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('confirms created payments and refuses re-confirm', async () => {
    const provider = new FakePaymentProvider();
    await provider.create({ paymentId: 'pay_5', amountMicros: 100, currency: 'CNY' });
    const confirmed = await provider.confirm('pay_5');
    expect(confirmed.status).toBe('confirmed');
    await expect(provider.confirm('pay_5')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('scripts confirm failures by id and by amount threshold', async () => {
    const byId = new FakePaymentProvider({ failConfirmPaymentIds: ['pay_bad'] });
    await byId.create({ paymentId: 'pay_bad', amountMicros: 1, currency: 'CNY' });
    expect((await byId.confirm('pay_bad')).status).toBe('failed');

    const byAmount = new FakePaymentProvider({ failConfirmAmountAboveMicros: 500 });
    await byAmount.create({ paymentId: 'pay_big', amountMicros: 600, currency: 'CNY' });
    await byAmount.create({ paymentId: 'pay_ok', amountMicros: 300, currency: 'CNY' });
    expect((await byAmount.confirm('pay_big')).status).toBe('failed');
    expect((await byAmount.confirm('pay_ok')).status).toBe('confirmed');
  });

  it('refunds confirmed payments and rejects premature or oversized refunds', async () => {
    const provider = new FakePaymentProvider();
    await provider.create({ paymentId: 'pay_6', amountMicros: 1000, currency: 'CNY' });
    await expect(provider.refund('pay_6', 500)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await provider.confirm('pay_6');
    const refunded = await provider.refund('pay_6', 500);
    expect(refunded.status).toBe('refunded');
    await expect(provider.refund('pay_6', 1)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('returns 404 for unknown payments and accepts any webhook (fake contract)', async () => {
    const provider = new FakePaymentProvider();
    await expect(provider.getStatus('pay_none')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(provider.confirm('pay_none')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(provider.verifyWebhook('sig', 'payload', 'secret')).resolves.toBe(true);
  });
});
