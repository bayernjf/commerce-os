import type { Hono, Context } from 'hono';
import { CommerceError, errorBody, httpStatusFor, type CommerceErrorCode } from '../util/errors.js';
import type { CommerceServices } from '../services.js';
import type { AlertKind, AlertReporter } from '../observability/alerts.js';
import { issueCartToken, verifyCartToken } from '../storefront/cart-token.js';

/** Map a retryable dependency error to its alert kind. */
const ALERT_BY_CODE: Partial<Record<CommerceErrorCode, AlertKind>> = {
  DECISION_UNAVAILABLE: 'decision_unavailable',
  CONTENT_UNAVAILABLE: 'content_unavailable',
  CHANNEL_UNAVAILABLE: 'channel_unavailable',
};

/**
 * HTTP routes v1. All business routes are under /api/v1 and require a
 * bearer token when COMMERCE_API_TOKEN is configured.
 */
export function registerHttpRoutes(
  app: Hono,
  deps: {
    token?: string;
    storefrontCartSecret?: string;
    webhookSecrets?: Record<string, string>;
    services: CommerceServices;
    reporter?: AlertReporter;
  },
): void {
  const { services } = deps;

  // ---- Storefront: public read + cart token (separate from ops Bearer) ---
  // Registered before the ops Bearer middleware so catalog and webhook stay
  // public and cart sessions use the `Cart <token>` scheme, never Bearer.
  const cartGuard = async (c: Context, next: () => Promise<void>) => {
    const cartId = c.req.param('id') ?? '';
    const secret = deps.storefrontCartSecret ?? '';
    const match = /^Cart ([a-f0-9]+)$/i.exec(c.req.header('Authorization') ?? '');
    if (!secret || !match || !verifyCartToken(cartId, match[1] ?? '', secret)) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'missing or invalid cart token', retryable: false } },
        401 as const,
      );
    }
    await next();
  };
  app.use('/api/v1/storefront/carts/:id', cartGuard);
  app.use('/api/v1/storefront/carts/:id/*', cartGuard);

  app.get('/api/v1/storefront/catalog', async (c) => c.json({ catalog: await services.storefrontCatalog.listCatalog() }));
  app.get('/api/v1/storefront/catalog/:id', async (c) => c.json({ item: await services.storefrontCatalog.getCatalogItem(c.req.param('id')) }));

  app.post('/api/v1/storefront/carts', async (c) => {
    const cart = await services.storefrontCarts.createCart({ merchantId: 'mer_owner' });
    const token = deps.storefrontCartSecret ? issueCartToken(cart.id, deps.storefrontCartSecret) : undefined;
    return c.json({ cart, ...(token ? { cartToken: token } : {}) }, 201);
  });
  app.get('/api/v1/storefront/carts/:id', async (c) => {
    const cart = await services.storefrontCarts.getCart(c.req.param('id'));
    const items = await services.storefrontCarts.listItems(cart.id);
    return c.json({ cart, items });
  });
  app.post('/api/v1/storefront/carts/:id/items', async (c) => {
    const body = (await c.req.json()) as { productId: string; skuId: string; qty: number };
    const items = await services.storefrontCarts.addItem(c.req.param('id'), body);
    return c.json({ items }, 201);
  });
  app.post('/api/v1/storefront/carts/:id/checkout', async (c) => {
    const body = (await c.req.json()) as { provider?: string };
    const checkout = await services.storefrontCheckouts.checkout(c.req.param('id'), body.provider ?? 'fake');
    return c.json({ checkout }, 201);
  });

  app.post('/api/v1/storefront/webhooks/:provider', async (c) => {
    const provider = c.req.param('provider');
    const secret = deps.webhookSecrets?.[provider];
    if (!secret) {
      throw new CommerceError('CREDENTIAL_MISSING', `webhook secret not configured for '${provider}'`, false, { provider });
    }
    const body = (await c.req.json()) as {
      deliveryId?: string;
      paymentId?: string;
      payload?: Record<string, unknown>;
      signature?: string;
    };
    if (!body.deliveryId || !body.payload || !body.signature) {
      throw new CommerceError('VALIDATION_FAILED', 'deliveryId, payload and signature are required');
    }
    const result = await services.storefrontWebhooks.handleDelivery({
      provider,
      secret,
      deliveryId: body.deliveryId,
      ...(body.paymentId ? { paymentId: body.paymentId } : {}),
      payload: body.payload,
      signature: body.signature,
    });
    return c.json({ result });
  });

  if (deps.token) {
    app.use('/api/v1/*', async (c, next) => {
      const header = c.req.header('Authorization') ?? '';
      if (header !== `Bearer ${deps.token}`) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid bearer token', retryable: false } }, 401 as const);
      }
      await next();
    });
  }

  app.onError((err, c) => {
    if (err instanceof CommerceError) {
      const status = httpStatusFor(err.code);
      const alertKind = ALERT_BY_CODE[err.code];
      if (status === 503 && alertKind) {
        deps.reporter?.report(alertKind, 'warning', err.message, { code: err.code });
      }
      return c.json({ error: errorBody(err) }, status as 400 | 401 | 404 | 409 | 422 | 423 | 501 | 503);
    }
    deps.reporter?.report('process_fatal', 'critical', `unhandled error: ${(err as Error).message}`);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message, retryable: false } }, 500);
  });

  // ---- Channel accounts ------------------------------------------------
  app.post('/api/v1/channel-accounts', async (c) => {
    const body = (await c.req.json()) as { channel: string; displayName: string; credentialRef?: string; status?: 'active' | 'disabled' };
    const account = await services.accounts.create(body);
    return c.json({ account }, 201);
  });
  app.get('/api/v1/channel-accounts', async (c) => c.json({ accounts: await services.accounts.list() }));

  // ---- Categories ------------------------------------------------------
  app.post('/api/v1/categories', async (c) => {
    const body = (await c.req.json()) as { name: string; channel?: string; parentId?: string; attributes?: string[] };
    const category = await services.products.createCategory(body);
    return c.json({ category }, 201);
  });
  app.get('/api/v1/categories', async (c) => c.json({ categories: await services.products.listCategories() }));

  // ---- Products --------------------------------------------------------
  app.post('/api/v1/products', async (c) => {
    const body = await c.req.json();
    const product = await services.products.createProduct(body);
    return c.json({ product }, 201);
  });
  app.get('/api/v1/products', async (c) => c.json({ products: await services.products.listProducts() }));
  app.get('/api/v1/products/:id', async (c) => c.json({ product: await services.products.getProduct(c.req.param('id')) }));

  // ---- Orders ----------------------------------------------------------
  app.post('/api/v1/orders/import', async (c) => {
    const body = (await c.req.json()) as { channelAccountId: string; since?: string };
    if (!body.channelAccountId) throw new CommerceError('VALIDATION_FAILED', 'channelAccountId is required');
    const result = await services.orders.importFromChannel(body.channelAccountId, body.since);
    return c.json({ result }, 201);
  });
  app.get('/api/v1/orders', async (c) => c.json({ orders: await services.orders.listOrders() }));
  app.get('/api/v1/orders/:id', async (c) => c.json({ order: await services.orders.getOrder(c.req.param('id')) }));

  // ---- Inventory (manual, M3 placeholder) ------------------------------
  app.post('/api/v1/inventory', async (c) => {
    const body = (await c.req.json()) as { skuId: string; qty: number };
    const row = await services.fulfillment.setInventory(body.skuId, body.qty);
    return c.json({ inventory: row }, 201);
  });
  app.get('/api/v1/inventory', async (c) => c.json({ inventory: await services.fulfillment.listInventory() }));

  // ---- Fulfillment / payment placeholders (visible 501 gaps) -----------
  app.post('/api/v1/fulfillment/ship', async () => services.fulfillment.placeholderShip());
  app.post('/api/v1/payments', async () => services.fulfillment.placeholderPay());

  // ---- Refunds / after-sale --------------------------------------------
  app.post('/api/v1/refunds', async (c) => {
    const body = (await c.req.json()) as {
      orderId: string;
      lines: { orderItemId?: string; qty?: number; amount?: number }[];
      reason: string;
    };
    const refund = await services.aftersales.requestRefund(body.orderId, { lines: body.lines ?? [], reason: body.reason });
    const status = (refund.status === 'awaiting_approval' ? 423 : 201) as 423 | 201;
    return c.json({ refund }, status);
  });
  app.post('/api/v1/refunds/:id/decision', async (c) => {
    const body = (await c.req.json()) as { verdict: 'approve' | 'reject'; approver: string; comment?: string };
    if (!body.approver) throw new CommerceError('VALIDATION_FAILED', 'approver is required');
    if (body.verdict !== 'approve' && body.verdict !== 'reject') {
      throw new CommerceError('VALIDATION_FAILED', "verdict must be 'approve' or 'reject'");
    }
    const refund = await services.aftersales.decideRefund(c.req.param('id'), body.verdict, body.approver, body.comment);
    return c.json({ refund });
  });
  app.get('/api/v1/refunds', async (c) => c.json({ refunds: await services.aftersales.listRefunds() }));
  app.get('/api/v1/refunds/:id', async (c) => c.json({ refund: await services.aftersales.getRefund(c.req.param('id')) }));

  // ---- Listings (content + publish) ------------------------------------
  app.post('/api/v1/listings', async (c) => {
    const body = await c.req.json();
    const submission = await services.publishing.submitListing({
      productId: body.productId,
      channelAccountId: body.channelAccountId,
      contentType: body.contentType,
      sellingPoints: body.sellingPoints,
      constraints: body.constraints,
    });
    const status = (submission.status === 'awaiting_approval' ? 423 : 201) as 423 | 201;
    return c.json({ submission }, status);
  });
  app.post('/api/v1/listings/:decisionId/approve', async (c) => {
    const body = (await c.req.json()) as { approver: string; comment?: string };
    if (!body.approver) throw new CommerceError('VALIDATION_FAILED', 'approver is required');
    const submission = await services.publishing.approveListing(c.req.param('decisionId'), body.approver, body.comment);
    return c.json({ submission });
  });
  app.post('/api/v1/listings/:decisionId/reject', async (c) => {
    const body = (await c.req.json()) as { approver: string; comment?: string };
    if (!body.approver) throw new CommerceError('VALIDATION_FAILED', 'approver is required');
    const result = await services.publishing.rejectListing(c.req.param('decisionId'), body.approver, body.comment);
    return c.json({ result });
  });

  // ---- Published content (read-only projection) --------------------------
  app.get('/api/v1/content', async (c) => c.json({ content: await services.contentReadModel.listContent() }));
  app.get('/api/v1/content/:id', async (c) => c.json({ content: await services.contentReadModel.getContent(c.req.param('id')) }));

  // ---- Local audit event stream ----------------------------------------
  app.get('/api/v1/events', async (c) => {
    const refType = c.req.query('refType');
    const refId = c.req.query('refId');
    const eventType = c.req.query('eventType');
    const events = await services.events.list({
      ...(refType ? { refType } : {}),
      ...(refId ? { refId } : {}),
      ...(eventType ? { eventType } : {}),
    });
    return c.json({ events });
  });

  app.get('/api/v1/dashboard', async (c) =>
    c.json({ metrics: await services.dashboard.getMetrics() }),
  );
}
