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
import type { DecisionPort } from '../src/decision/types.js';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

describe('storefront checkout decision gating (SF-09)', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => teardownHarness(h));

  async function cartWithItem(price = 9999): Promise<{ cartId: string }> {
    const product = await h.services.products.createProduct({
      title: '决策商品',
      skus: [{ skuCode: 'SKU-DEC-1', price, currency: 'CNY' }],
    });
    await h.services.products.setExternalRef(product.id, 'ext-dec-1');
    const cart = await h.services.storefrontCarts.createCart({ merchantId: 'mer_owner' });
    await h.services.storefrontCarts.addItem(cart.id, { productId: product.id, skuId: product.skus[0]?.id ?? '', qty: 1 });
    return { cartId: cart.id };
  }

  it('parks high-impact checkout as pending with a decision id (D3 held)', async () => {
    const { cartId } = await cartWithItem();
    const checkout = await h.services.storefrontCheckouts.checkout(cartId);

    expect(checkout.status).toBe('pending');
    expect(checkout.decisionId).toMatch(/^dec_/);
    expect(checkout.orderId).toBeUndefined();
    expect(checkout.paymentId).toBeUndefined();

    const orders = await h.services.orders.listOrders();
    expect(orders).toHaveLength(0);
    const cart = await h.services.storefrontCarts.getCart(cartId);
    expect(cart.status).toBe('open');

    // Re-checkout is idempotent: still the same pending checkout.
    const again = await h.services.storefrontCheckouts.checkout(cartId);
    expect(again.id).toBe(checkout.id);
  });

  it('approve resumes the checkout to paid with order and closed cart', async () => {
    const { cartId } = await cartWithItem(1299);
    const pending = await h.services.storefrontCheckouts.checkout(cartId);
    expect(pending.status).toBe('pending');

    const paid = await h.services.storefrontCheckouts.approveCheckout(pending.decisionId ?? '', 'owner');
    expect(paid.status).toBe('paid');
    expect(paid.orderId).toMatch(/^ord_/);
    expect(paid.totalMicros).toBe(1299_000_000);

    const orders = await h.services.orders.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe('paid');
    const cart = await h.services.storefrontCarts.getCart(cartId);
    expect(cart.status).toBe('checked_out');
  });

  it('reject parks the checkout as rejected and never creates an order', async () => {
    const { cartId } = await cartWithItem();
    const pending = await h.services.storefrontCheckouts.checkout(cartId);

    const rejected = await h.services.storefrontCheckouts.rejectCheckout(pending.decisionId ?? '', 'owner');
    expect(rejected.status).toBe('rejected');

    const stored = await h.services.storefrontCheckouts.getCheckout(rejected.checkoutId);
    expect(stored.status).toBe('rejected');
    expect(await h.services.orders.listOrders()).toHaveLength(0);
    const cart = await h.services.storefrontCarts.getCart(cartId);
    expect(cart.status).toBe('open');
  });

  it('returns 404 for unknown decisions', async () => {
    await expect(h.services.storefrontCheckouts.approveCheckout('dec_nope', 'owner')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(h.services.storefrontCheckouts.rejectCheckout('dec_nope', 'owner')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('decided checkouts finalize immediately (no parking)', async () => {
    const driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    try {
      const registry = createDefaultRegistry();
      const accounts = new ChannelAccountService(driver);
      const products = new ProductService(driver);
      const carts = new CartService(driver);
      const orders = new OrderService(driver, registry, accounts);
      const payments = new PaymentRegistry();
      payments.register(new FakePaymentProvider());
      const decisions: DecisionPort = {
        decide: async () => ({ decisionId: 'dec_auto', grade: 'D0', mode: 'auto', status: 'decided', ruleId: 'test' }),
        approve: async (id) => ({ decisionId: id, grade: 'D0', mode: 'auto', status: 'decided' }),
        reject: async (id) => ({ decisionId: id, grade: 'D0', mode: 'auto', status: 'rejected' }),
      };
      const checkouts = new CheckoutService(driver, carts, orders, payments, decisions);

      const product = await products.createProduct({ title: '直通商品', skus: [{ skuCode: 'SKU-AUTO', price: 10 }] });
      await products.setExternalRef(product.id, 'ext-auto');
      const cart = await carts.createCart({ merchantId: 'mer_owner' });
      await carts.addItem(cart.id, { productId: product.id, skuId: product.skus[0]?.id ?? '', qty: 1 });

      const checkout = await checkouts.checkout(cart.id);
      expect(checkout.status).toBe('paid');
      expect(checkout.decisionId).toBe('dec_auto');
    } finally {
      await driver.close();
    }
  });
});
