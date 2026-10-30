import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/server.js';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

const CART_SECRET = 'test-cart-secret';

describe('storefront order status + refunds (SF-12)', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    h = await setupHarness();
    app = createApp({ services: h.services, storefrontCartSecret: CART_SECRET });
  });
  afterEach(async () => teardownHarness(h));

  async function paidCart(price = 1999): Promise<{ cartId: string; token: string; orderItemId: string }> {
    const product = await h.services.products.createProduct({
      title: '订单页商品',
      skus: [{ skuCode: 'SKU-ORD-1', price, currency: 'CNY' }],
    });
    await h.services.products.setExternalRef(product.id, 'ext-ord-1');
    const cartRes = await app.request('/api/v1/storefront/carts', { method: 'POST' });
    const { cart, cartToken } = (await cartRes.json()) as { cart: { id: string }; cartToken: string };
    const cartId = cart.id;
    const token = cartToken;
    const headers = { 'content-type': 'application/json', authorization: `Cart ${token}` };

    await app.request(`/api/v1/storefront/carts/${cartId}/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ productId: product.id, skuId: product.skus[0]?.id ?? '', qty: 1 }),
    });
    const co = await app.request(`/api/v1/storefront/carts/${cartId}/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    const { checkout } = (await co.json()) as { checkout: { decisionId: string } };
    const paid = await app.request(`/api/v1/storefront/checkouts/${checkout.decisionId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'owner' }),
    });
    const { checkout: paidCheckout } = (await paid.json()) as { checkout: { status: string } };
    expect(paidCheckout.status).toBe('paid');

    const orderRes = await app.request(`/api/v1/storefront/carts/${cartId}/order`, { headers });
    const { order } = (await orderRes.json()) as { order: { lines: { id: string }[] } };
    return { cartId, token, orderItemId: order.lines[0]?.id ?? '' };
  }

  it('returns the paid order for a checked-out cart under the cart token', async () => {
    const { cartId, token } = await paidCart();
    const res = await app.request(`/api/v1/storefront/carts/${cartId}/order`, {
      headers: { authorization: `Cart ${token}` },
    });
    expect(res.status).toBe(200);
    const { order } = (await res.json()) as {
      order: { status: string; channel: string; externalOrderId: string; totalAmount: number; lines: unknown[] };
    };
    expect(order.status).toBe('paid');
    expect(order.channel).toBe('storefront');
    expect(order.externalOrderId).toBe(`sf-${cartId}`);
    expect(order.totalAmount).toBe(1999);
    expect(order.lines).toHaveLength(1);
  });

  it('returns 401 without a valid cart token and 404 before checkout', async () => {
    const cartRes = await app.request('/api/v1/storefront/carts', { method: 'POST' });
    const { cart, cartToken } = (await cartRes.json()) as { cart: { id: string }; cartToken: string };
    const noToken = await app.request(`/api/v1/storefront/carts/${cart.id}/order`);
    expect(noToken.status).toBe(401);

    const badToken = await app.request(`/api/v1/storefront/carts/${cart.id}/order`, {
      headers: { authorization: 'Cart deadbeef' },
    });
    expect(badToken.status).toBe(401);

    const goodToken = await app.request(`/api/v1/storefront/carts/${cart.id}/order`, {
      headers: { authorization: `Cart ${cartToken}` },
    });
    expect(goodToken.status).toBe(404);
  });

  it('requests a refund via the cart token and parks it at D2 awaiting approval', async () => {
    const { cartId, token, orderItemId } = await paidCart(1999);
    const headers = { 'content-type': 'application/json', authorization: `Cart ${token}` };

    const res = await app.request(`/api/v1/storefront/carts/${cartId}/refunds`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: '不想要了', orderItemId }),
    });
    expect(res.status).toBe(423);
    const { refund } = (await res.json()) as {
      refund: { id: string; status: string; reason: string; lines: { amount: number }[] };
    };
    expect(refund.reason).toBe('不想要了');
    expect(refund.status).toBe('awaiting_approval');
    expect(refund.lines.reduce((sum, l) => sum + l.amount, 0)).toBe(1999);

    const listRes = await app.request(`/api/v1/storefront/carts/${cartId}/refunds`, { headers });
    expect(listRes.status).toBe(200);
    const { refunds } = (await listRes.json()) as { refunds: { id: string }[] };
    expect(refunds.map((r) => r.id)).toContain(refund.id);
  });

  it('rejects refund without reason or order item', async () => {
    const { cartId, token } = await paidCart();
    const headers = { 'content-type': 'application/json', authorization: `Cart ${token}` };
    const noReason = await app.request(`/api/v1/storefront/carts/${cartId}/refunds`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orderItemId: 'x' }),
    });
    expect(noReason.status).toBe(400);
    const noItem = await app.request(`/api/v1/storefront/carts/${cartId}/refunds`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: '测试' }),
    });
    expect(noItem.status).toBe(400);
  });

  it('settles an approved refund through the storefront fake payout', async () => {
    const { cartId, token, orderItemId } = await paidCart();
    const headers = { 'content-type': 'application/json', authorization: `Cart ${token}` };
    const res = await app.request(`/api/v1/storefront/carts/${cartId}/refunds`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: '退款闭环验证', orderItemId }),
    });
    expect(res.status).toBe(423);
    const { refund } = (await res.json()) as { refund: { id: string } };
    const refundId = refund.id;

    const decision = await app.request(`/api/v1/refunds/${refundId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve', approver: 'owner' }),
    });
    expect(decision.status).toBe(200);
    const { refund: settled } = (await decision.json()) as {
      refund: { status: string; externalRefundRef?: string };
    };
    expect(settled.status).toBe('succeeded');
    expect(settled.externalRefundRef).toContain('fake-refund-');

    const listRes = await app.request(`/api/v1/storefront/carts/${cartId}/refunds`, { headers });
    const { refunds } = (await listRes.json()) as { refunds: { id: string; status: string }[] };
    const entry = refunds.find((r) => r.id === refundId);
    expect(entry?.status).toBe('succeeded');
  });
});
