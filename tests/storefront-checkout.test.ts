import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { ProductService } from '../src/product/product-service.js';
import { CartService } from '../src/storefront/cart-service.js';
import { FakePaymentProvider } from '../src/storefront/fake-payment-provider.js';
import { PaymentRegistry } from '../src/storefront/payment-registry.js';
import { CheckoutService } from '../src/storefront/checkout-service.js';
import { OrderService } from '../src/order/order-service.js';
import { ChannelAccountService } from '../src/channel/channel-account-service.js';
import { createDefaultRegistry } from '../src/channel/index.js';
import type { CommerceDecision, DecisionPort } from '../src/decision/types.js';

function decidedPort(): DecisionPort {
  return {
    decide: async () => ({ decisionId: 'dec_test', grade: 'D0', mode: 'auto', status: 'decided', ruleId: 'test' }),
    approve: async (id) => ({ decisionId: id, grade: 'D0', mode: 'auto', status: 'decided' }),
    reject: async (id) => ({ decisionId: id, grade: 'D0', mode: 'auto', status: 'rejected' }),
  };
}

/** A checkout held for approval; the approval settles with a scripted status. */
function heldPort(approveStatus: CommerceDecision['status'] = 'decided'): DecisionPort {
  return {
    decide: async () => ({ decisionId: 'dec_held', grade: 'D2', mode: 'approve-sync', status: 'awaiting_approval', ruleId: 'test' }),
    approve: async (id) => ({ decisionId: id, grade: 'D2', mode: 'approve-sync', status: approveStatus, ruleId: 'test' }),
    reject: async (id) => ({ decisionId: id, grade: 'D2', mode: 'approve-sync', status: 'rejected', ruleId: 'test' }),
  };
}

describe('storefront checkout service (SF-04)', () => {
  let driver: SqliteDriver;
  let products: ProductService;
  let carts: CartService;
  let checkouts: CheckoutService;
  let orders: OrderService;
  let payments: PaymentRegistry;

  beforeEach(async () => {
    driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    const registry = createDefaultRegistry();
    const accounts = new ChannelAccountService(driver);
    const eventLog = { list: async () => [], record: async () => {} } as never;
    products = new ProductService(driver);
    carts = new CartService(driver);
    orders = new OrderService(driver, registry, accounts, eventLog);
    payments = new PaymentRegistry();
    payments.register(new FakePaymentProvider());
    checkouts = new CheckoutService(driver, carts, orders, payments, decidedPort());
  });
  afterEach(async () => driver.close());

  async function cartWithItems(prices: number[] = [99.9, 10]): Promise<{ cartId: string; productIds: string[] }> {
    const cart = await carts.createCart({ merchantId: 'mer_owner' });
    const productIds: string[] = [];
    for (const [i, price] of prices.entries()) {
      const p = await products.createProduct({ title: `结算商品${i}`, skus: [{ skuCode: `SKU-CHK-${i}`, price, currency: 'CNY' }] });
      await products.setExternalRef(p.id, `ext-chk-${i}`);
      await carts.addItem(cart.id, { productId: p.id, skuId: p.skus[0]?.id ?? '', qty: 1 });
      productIds.push(p.id);
    }
    return { cartId: cart.id, productIds };
  }

  it('checks out a cart into a paid storefront order with confirmed payment', async () => {
    const { cartId } = await cartWithItems([99.9, 10]);
    const checkout = await checkouts.checkout(cartId);

    expect(checkout.status).toBe('paid');
    expect(checkout.provider).toBe('fake');
    expect(checkout.totalMicros).toBe(109_900_000);
    expect(checkout.currency).toBe('CNY');
    expect(checkout.orderId).toMatch(/^ord_/);
    expect(checkout.paymentId).toMatch(/^pay_/);

    const order = await orders.getOrder(checkout.orderId as string);
    expect(order.channel).toBe('storefront');
    expect(order.externalOrderId).toBe(`sf-${cartId}`);
    expect(order.status).toBe('paid');
    expect(order.totalAmount).toBeCloseTo(109.9, 6);
    expect(order.lines).toHaveLength(2);

    const cart = await carts.getCart(cartId);
    expect(cart.status).toBe('checked_out');
  });

  it('is idempotent: re-checkout returns the same checkout without a duplicate order', async () => {
    const { cartId } = await cartWithItems([50]);
    const first = await checkouts.checkout(cartId);
    const second = await checkouts.checkout(cartId);

    expect(second.id).toBe(first.id);
    expect(second.orderId).toBe(first.orderId);
    const all = await driver.all('SELECT id FROM orders WHERE channel = ?', ['storefront']);
    expect(all).toHaveLength(1);
  });

  it('fails closed on confirm failure and leaves cart open and order imported', async () => {
    const { cartId } = await cartWithItems([999]);
    const payments = new PaymentRegistry();
    payments.register(new FakePaymentProvider({ failConfirmAmountAboveMicros: 500_000_000 }));
    const failing = new CheckoutService(driver, carts, orders, payments, decidedPort());

    const checkout = await failing.checkout(cartId);
    expect(checkout.status).toBe('failed');

    const cart = await carts.getCart(cartId);
    expect(cart.status).toBe('open');
    const order = await orders.getOrder(checkout.orderId as string);
    expect(order.status).toBe('imported');
  });

  it('rejects empty carts, non-open carts and unknown carts', async () => {
    const empty = await carts.createCart({ merchantId: 'mer_owner' });
    await expect(checkouts.checkout(empty.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(checkouts.checkout('cart_unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to finalize when the approval comes back unsettled (P2-1)', async () => {
    const { cartId } = await cartWithItems();
    const held = new CheckoutService(driver, carts, orders, payments, heldPort('blocked'));
    const parked = await held.checkout(cartId);
    expect(parked.status).toBe('pending');

    await expect(held.approveCheckout('dec_held', 'ops')).rejects.toMatchObject({ code: 'CONFLICT' });
    const after = await held.getCheckout(parked.id);
    expect(after.status).toBe('pending'); // not silently rejected, not finalized
    expect(after.paymentId).toBeUndefined(); // no money moved
    expect(await driver.all('SELECT * FROM payments')).toHaveLength(0);
  });

  it('keeps the provider chosen at checkout through the approval (P2-4)', async () => {
    // A second provider with a different name: the fake logic, relabeled.
    payments.register(Object.assign(new FakePaymentProvider(), { provider: 'alt' }));
    const { cartId } = await cartWithItems();
    const held = new CheckoutService(driver, carts, orders, payments, heldPort('decided'));
    const parked = await held.checkout(cartId, 'alt');
    expect(parked.status).toBe('pending');

    const approved = await held.approveCheckout('dec_held', 'ops');
    expect(approved.status).toBe('paid');
    expect(approved.provider).toBe('alt'); // not the hardcoded 'fake'
    const payRow = await driver.get<Record<string, unknown>>('SELECT provider FROM payments WHERE checkout_id = ?', [parked.id]);
    expect(payRow?.provider).toBe('alt');
  });

  it('settles a raced double approval onto a single payment (P2-5)', async () => {
    const { cartId } = await cartWithItems();
    const held = new CheckoutService(driver, carts, orders, payments, heldPort('decided'));
    const parked = await held.checkout(cartId);

    const [first, second] = await Promise.allSettled([
      held.approveCheckout('dec_held', 'ops'),
      held.approveCheckout('dec_held', 'ops'),
    ]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    const loser = [first, second].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: 'CONFLICT' });
    // Exactly one payment row and one paid checkout — no double charge.
    expect(await driver.all('SELECT * FROM payments WHERE checkout_id = ?', [parked.id])).toHaveLength(1);
    expect((await held.getCheckout(parked.id)).status).toBe('paid');
  });

  it('rejects a cart mixing currencies instead of summing across them (P2-7)', async () => {
    const cart = await carts.createCart({ merchantId: 'mer_owner' });
    const cny = await products.createProduct({ title: '人民币商品', skus: [{ skuCode: 'SKU-MIX-CNY', price: 10, currency: 'CNY' }] });
    const usd = await products.createProduct({ title: 'usd item', skus: [{ skuCode: 'SKU-MIX-USD', price: 5, currency: 'USD' }] });
    await products.setExternalRef(cny.id, 'ext-mix-cny');
    await products.setExternalRef(usd.id, 'ext-mix-usd');
    await carts.addItem(cart.id, { productId: cny.id, skuId: cny.skus[0]!.id, qty: 1 });
    await carts.addItem(cart.id, { productId: usd.id, skuId: usd.skus[0]!.id, qty: 1 });

    await expect(checkouts.checkout(cart.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await driver.all('SELECT * FROM checkouts')).toHaveLength(0);
  });
});
