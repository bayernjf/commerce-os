import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/server.js';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';
import { signPayload } from '../src/storefront/webhook-service.js';

const CART_SECRET = 'test-cart-secret';
const WEBHOOK_SECRET = 'test-webhook-secret';

describe('storefront HTTP layer (SF-08)', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    h = await setupHarness();
    app = createApp({
      services: h.services,
      storefrontCartSecret: CART_SECRET,
      webhookSecrets: { fake: WEBHOOK_SECRET },
    });
  });
  afterEach(async () => teardownHarness(h));

  async function listProduct(title: string, price: number): Promise<{ id: string; skuId: string }> {
    const product = await h.services.products.createProduct({ title, skus: [{ skuCode: `SF8-${title}`, price }] });
    await h.services.products.setExternalRef(product.id, `ext-${title}`);
    return { id: product.id, skuId: product.skus[0]?.id ?? '' };
  }

  async function createCart(): Promise<{ cartId: string; token: string }> {
    const res = await app.request('/api/v1/storefront/carts', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { cart: { id: string }; cartToken: string };
    return { cartId: body.cart.id, token: body.cartToken };
  }

  it('serves the catalog publicly without any token', async () => {
    const { id } = await listProduct('前台商品', 1299);
    const res = await app.request('/api/v1/storefront/catalog');
    expect(res.status).toBe(200);
    const { catalog } = (await res.json()) as { catalog: { productId: string; title: string }[] };
    expect(catalog.map((i) => i.productId)).toContain(id);

    const one = await app.request(`/api/v1/storefront/catalog/${id}`);
    expect(one.status).toBe(200);
    const missing = await app.request('/api/v1/storefront/catalog/prd_nope');
    expect(missing.status).toBe(404);
  });

  it('creates a cart and returns a stateless cart token', async () => {
    const { cartId, token } = await createCart();
    expect(cartId).toMatch(/^cart_/);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('guards cart endpoints with the Cart token scheme', async () => {
    const { cartId } = await createCart();

    const noToken = await app.request(`/api/v1/storefront/carts/${cartId}`);
    expect(noToken.status).toBe(401);

    const badToken = await app.request(`/api/v1/storefront/carts/${cartId}`, {
      headers: { Authorization: 'Cart deadbeef' },
    });
    expect(badToken.status).toBe(401);

    const wrongScheme = await app.request(`/api/v1/storefront/carts/${cartId}`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(wrongScheme.status).toBe(401);
  });

  it('adds items and checks out with a valid cart token', async () => {
    const { id: productId, skuId } = await listProduct('结算商品', 99.9);
    expect(skuId).not.toBe('');

    const { cartId, token } = await createCart();
    const headers = { 'content-type': 'application/json', Authorization: `Cart ${token}` };

    const add = await app.request(`/api/v1/storefront/carts/${cartId}/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ productId, skuId, qty: 2 }),
    });
    expect(add.status).toBe(201);
    const { items } = (await add.json()) as { items: { qty: number; unitAmountMicros: number }[] };
    expect(items[0]?.qty).toBe(2);

    const detail = await app.request(`/api/v1/storefront/carts/${cartId}`, { headers });
    expect(detail.status).toBe(200);

    const checkoutRes = await app.request(`/api/v1/storefront/carts/${cartId}/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    expect(checkoutRes.status).toBe(201);
    const { checkout } = (await checkoutRes.json()) as { checkout: { status: string; decisionId?: string } };
    // Storefront checkout is external money: zeus D3 grades it held (SF-09).
    expect(checkout.status).toBe('pending');
    expect(checkout.decisionId).toMatch(/^dec_/);

    const approveRes = await app.request(`/api/v1/storefront/checkouts/${checkout.decisionId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'owner' }),
    });
    expect(approveRes.status).toBe(200);
    const { checkout: paid } = (await approveRes.json()) as { checkout: { status: string; totalMicros: number } };
    expect(paid.status).toBe('paid');
    expect(paid.totalMicros).toBe(199_800_000);
  });

  it('verifies webhook signatures and keeps public endpoints separate from ops Bearer', async () => {
    const payload = { type: 'payment.confirmed', paymentId: 'pay_9' };
    const signature = signPayload(JSON.stringify(payload), WEBHOOK_SECRET);

    const ok = await app.request('/api/v1/storefront/webhooks/fake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: 'del_9', paymentId: 'pay_9', payload, signature }),
    });
    expect(ok.status).toBe(200);

    const bad = await app.request('/api/v1/storefront/webhooks/fake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: 'del_bad', paymentId: 'pay_9', payload, signature: 'nope' }),
    });
    expect(bad.status).toBe(401);

    const unconfigured = await app.request('/api/v1/storefront/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: 'del_1', payload, signature }),
    });
    expect(unconfigured.status).toBe(422);

    // Ops Bearer applies to admin routes but never blocks storefront public routes.
    const secured = createApp({
      token: 'ops-secret',
      services: h.services,
      storefrontCartSecret: CART_SECRET,
      webhookSecrets: { fake: WEBHOOK_SECRET },
    });
    const adminNoToken = await secured.request('/api/v1/products');
    expect(adminNoToken.status).toBe(401);
    const catalogPublic = await secured.request('/api/v1/storefront/catalog');
    expect(catalogPublic.status).toBe(200);
    const webhookPublic = await secured.request('/api/v1/storefront/webhooks/fake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: 'del_2', payload, signature }),
    });
    expect(webhookPublic.status).toBe(200);
  });
});
