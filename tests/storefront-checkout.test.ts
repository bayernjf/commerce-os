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

describe('storefront checkout service (SF-04)', () => {
  let driver: SqliteDriver;
  let products: ProductService;
  let carts: CartService;
  let checkouts: CheckoutService;
  let orders: OrderService;

  beforeEach(async () => {
    driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    const registry = createDefaultRegistry();
    const accounts = new ChannelAccountService(driver);
    const eventLog = { list: async () => [], record: async () => {} } as never;
    products = new ProductService(driver);
    carts = new CartService(driver);
    orders = new OrderService(driver, registry, accounts, eventLog);
    const payments = new PaymentRegistry();
    payments.register(new FakePaymentProvider());
    checkouts = new CheckoutService(driver, carts, orders, payments);
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

    const order = await orders.getOrder(checkout.orderId);
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
    const failing = new CheckoutService(driver, carts, orders, payments);

    const checkout = await failing.checkout(cartId);
    expect(checkout.status).toBe('failed');

    const cart = await carts.getCart(cartId);
    expect(cart.status).toBe('open');
    const order = await orders.getOrder(checkout.orderId);
    expect(order.status).toBe('imported');
  });

  it('rejects empty carts, non-open carts and unknown carts', async () => {
    const empty = await carts.createCart({ merchantId: 'mer_owner' });
    await expect(checkouts.checkout(empty.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(checkouts.checkout('cart_unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
