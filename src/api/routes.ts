import type { Hono } from 'hono';
import { CommerceError, errorBody, httpStatusFor } from '../util/errors.js';
import type { CommerceServices } from '../services.js';

/**
 * HTTP routes v1. All business routes are under /api/v1 and require a
 * bearer token when COMMERCE_API_TOKEN is configured.
 */
export function registerHttpRoutes(app: Hono, deps: { token?: string; services: CommerceServices }): void {
  const { services } = deps;

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
      return c.json({ error: errorBody(err) }, httpStatusFor(err.code) as 400 | 404 | 409 | 422 | 423 | 501 | 503);
    }
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
