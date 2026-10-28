import type { StorageDriver } from '../storage/driver.js';
import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';
import type { CartService } from './cart-service.js';
import type { PaymentRegistry } from './payment-registry.js';
import type { OrderService } from '../order/order-service.js';
import type { DecisionPort } from '../decision/types.js';
import type { EventLog } from '../storage/event-log.js';

/**
 * Storefront checkout service (SF-04 + SF-09, Tier0-独立站双用 v1.0 §5.3).
 * Flow: cart validation → zeus decision (SF-09: money actions never grade
 * locally) → held checkouts park as 'pending' with a decisionId until
 * approved/rejected; decided checkouts finalize immediately (idempotent
 * storefront order + PaymentPort.create/confirm → paid/failed).
 * Re-checking out the same cart returns the existing checkout.
 */

export type CheckoutStatus = 'pending' | 'paid' | 'failed' | 'rejected';

export interface Checkout {
  id: string;
  cartId: string;
  orderId?: string;
  paymentId?: string;
  provider: string;
  status: CheckoutStatus;
  totalMicros: number;
  currency: string;
  decisionId?: string;
  createdAt: string;
  decidedAt?: string;
}

function validationError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('VALIDATION_FAILED', message, false, details);
}
function notFoundError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('NOT_FOUND', message, false, details);
}
function conflictError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('CONFLICT', message, false, details);
}

export class CheckoutService {
  constructor(
    private readonly driver: StorageDriver,
    private readonly carts: CartService,
    private readonly orders: OrderService,
    private readonly payments: PaymentRegistry,
    private readonly decisions: DecisionPort,
    private readonly events?: EventLog,
  ) {}

  async checkout(cartId: string, providerName = 'fake'): Promise<Checkout> {
    const existing = await this.findExisting(cartId);
    if (existing) return existing;

    const cart = await this.carts.getCart(cartId);
    if (cart.status !== 'open') {
      throw validationError(`cart is not open: ${cartId}`, { cartId, status: cart.status });
    }

    const lines = await this.loadLines(cartId);
    if (lines.length === 0) throw validationError(`cart is empty: ${cartId}`, { cartId });

    const totalMicros = lines.reduce((sum, l) => sum + l.unitAmountMicros * l.qty, 0);
    const currency = String(lines[0]?.currency ?? 'CNY');
    const checkoutId = newId('cko');

    const decision = await this.decisions.decide({
      intent: 'storefront.checkout',
      domain: 'commerce',
      amount: { value: totalMicros / 1_000_000, currency },
      impact: 'external',
      reversibility: 'reversible',
      riskTags: ['storefront', providerName],
      proposal: `checkout cart ${cartId} (${currency} ${(totalMicros / 1_000_000).toFixed(2)})`,
      idempotencyKey: `checkout:${cartId}`,
    });
    await this.recordEvent('decision.requested', checkoutId, {
      decisionId: decision.decisionId,
      grade: decision.grade,
      status: decision.status,
      cartId,
    });

    await this.driver.run(
      `INSERT INTO checkouts (id, merchant_id, cart_id, status, decision_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [checkoutId, cart.merchantId, cartId, 'pending', decision.decisionId, nowIso()],
    );

    if (decision.status === 'awaiting_approval' || decision.status === 'blocked') {
      return this.getCheckout(checkoutId);
    }
    return this.finalize(checkoutId, cartId, lines, totalMicros, currency, providerName);
  }

  async approveCheckout(decisionId: string, approver: string, comment?: string): Promise<Checkout> {
    const row = await this.findByDecision(decisionId);
    const decision = await this.decisions.approve(decisionId, approver, comment);
    if (decision.status === 'rejected') {
      await this.markRejected(String(row.id));
      throw conflictError(`checkout decision was rejected: ${decisionId}`, { decisionId });
    }
    const cart = await this.carts.getCart(String(row.cart_id));
    const lines = await this.loadLines(cart.id);
    const totalMicros = lines.reduce((sum, l) => sum + l.unitAmountMicros * l.qty, 0);
    const currency = String(lines[0]?.currency ?? 'CNY');
    return this.finalize(String(row.id), cart.id, lines, totalMicros, currency, 'fake');
  }

  async rejectCheckout(decisionId: string, approver: string, comment?: string): Promise<{ checkoutId: string; status: 'rejected' }> {
    const row = await this.findByDecision(decisionId);
    await this.decisions.reject(decisionId, approver, comment);
    await this.markRejected(String(row.id));
    await this.recordEvent('checkout.rejected', String(row.id), { decisionId, approver, comment: comment ?? null });
    return { checkoutId: String(row.id), status: 'rejected' };
  }

  async getCheckout(id: string): Promise<Checkout> {
    const row = await this.findRow('id', id);
    if (!row) throw notFoundError(`checkout not found: ${id}`, { checkoutId: id });
    return this.mapCheckout(row);
  }

  private async finalize(
    checkoutId: string,
    cartId: string,
    lines: { skuId: string; skuCode: string; title: string; qty: number; unitAmountMicros: number; currency: string }[],
    totalMicros: number,
    currency: string,
    providerName: string,
  ): Promise<Checkout> {
    const port = this.payments.get(providerName);
    const order = await this.ensureOrder(cartId, lines, totalMicros, currency);

    const now = nowIso();
    const paymentId = newId('pay');
    await port.create({ paymentId, amountMicros: totalMicros, currency });
    await this.driver.run(
      `INSERT INTO payments (id, checkout_id, provider, status, external_ref, amount_micros, raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [paymentId, checkoutId, port.provider, 'created', null, totalMicros, '{}', now, now],
    );

    const confirmed = await port.confirm(paymentId);
    const status: 'paid' | 'failed' = confirmed.status === 'confirmed' ? 'paid' : 'failed';
    const decidedAt = nowIso();
    await this.driver.run(
      `UPDATE checkouts SET status = ?, order_id = ?, payment_id = ?, decided_at = ? WHERE id = ?`,
      [status, order.id, paymentId, decidedAt, checkoutId],
    );
    await this.driver.run(
      `UPDATE payments SET status = ?, external_ref = ?, updated_at = ? WHERE id = ?`,
      [confirmed.status, confirmed.externalRef ?? null, decidedAt, paymentId],
    );
    if (status === 'paid') {
      await this.orders.setStatus(order.id, 'paid');
      await this.driver.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);
      await this.recordEvent('checkout.completed', checkoutId, {
        orderId: order.id,
        paymentId,
        totalMicros,
        currency,
        status,
      });
    }
    return this.getCheckout(checkoutId);
  }

  private async findByDecision(decisionId: string): Promise<Record<string, unknown>> {
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM checkouts WHERE decision_id = ?', [decisionId]);
    if (!row) throw notFoundError(`no checkout found for decision ${decisionId}`, { decisionId });
    return row;
  }

  private async markRejected(checkoutId: string): Promise<void> {
    await this.driver.run(`UPDATE checkouts SET status = 'rejected', decided_at = ? WHERE id = ?`, [nowIso(), checkoutId]);
  }

  private async recordEvent(eventType: string, refId: string, payload: Record<string, unknown>): Promise<void> {
    await this.events?.record({ eventType, refType: 'checkout', refId, payload });
  }

  private async findExisting(cartId: string): Promise<Checkout | null> {
    const row = await this.findRow('cart_id', cartId);
    return row ? this.mapCheckout(row) : null;
  }

  private async findRow(column: 'id' | 'cart_id', value: string): Promise<Record<string, unknown> | null> {
    const row = await this.driver.get<Record<string, unknown>>(
      `SELECT c.*, p.amount_micros AS payment_amount_micros, p.provider AS payment_provider, o.currency AS order_currency
       FROM checkouts c
       LEFT JOIN payments p ON p.id = c.payment_id
       LEFT JOIN orders o ON o.id = c.order_id
       WHERE c.${column} = ?
       ORDER BY c.created_at DESC LIMIT 1`,
      [value],
    );
    return row ?? null;
  }

  private async loadLines(cartId: string): Promise<{
    skuId: string;
    skuCode: string;
    title: string;
    qty: number;
    unitAmountMicros: number;
    currency: string;
  }[]> {
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT ci.sku_id, s.sku_code, p.title, ci.qty, ci.unit_amount_micros, s.currency
       FROM cart_items ci
       JOIN skus s ON s.id = ci.sku_id
       JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = ?
       ORDER BY ci.id ASC`,
      [cartId],
    );
    return rows.map((r) => ({
      skuId: String(r.sku_id),
      skuCode: String(r.sku_code),
      title: String(r.title),
      qty: Number(r.qty),
      unitAmountMicros: Number(r.unit_amount_micros),
      currency: String(r.currency),
    }));
  }

  /** Idempotent order creation: one order per cart (channel=storefront). */
  private async ensureOrder(
    cartId: string,
    lines: { skuId: string; skuCode: string; title: string; qty: number; unitAmountMicros: number; currency: string }[],
    totalMicros: number,
    currency: string,
  ): Promise<{ id: string }> {
    const externalOrderId = `sf-${cartId}`;
    const existing = await this.driver.get<Record<string, unknown>>(
      'SELECT id FROM orders WHERE channel = ? AND external_order_id = ?',
      ['storefront', externalOrderId],
    );
    if (existing) return { id: String(existing.id) };

    const now = nowIso();
    const orderId = newId('ord', externalOrderId);
    await this.driver.run(
      `INSERT INTO orders (id, channel, external_order_id, status, total_amount, currency, created_at, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, 'storefront', externalOrderId, 'imported', totalMicros / 1_000_000, currency, now, now],
    );
    for (const line of lines) {
      const itemId = newId('itm', `${externalOrderId}-${line.skuCode}`);
      await this.driver.run(
        `INSERT INTO order_items (id, order_id, sku_id, external_sku_code, title, qty, price)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [itemId, orderId, line.skuId, line.skuCode, line.title, line.qty, line.unitAmountMicros / 1_000_000],
      );
    }
    return { id: orderId };
  }

  private mapCheckout(r: Record<string, unknown>): Checkout {
    return {
      id: String(r.id),
      cartId: String(r.cart_id),
      ...(r.order_id ? { orderId: String(r.order_id) } : {}),
      ...(r.payment_id ? { paymentId: String(r.payment_id) } : {}),
      provider: String(r.payment_provider ?? ''),
      status: r.status as CheckoutStatus,
      totalMicros: Number(r.payment_amount_micros ?? 0),
      currency: String(r.order_currency ?? ''),
      ...(r.decision_id ? { decisionId: String(r.decision_id) } : {}),
      createdAt: String(r.created_at),
      ...(r.decided_at ? { decidedAt: String(r.decided_at) } : {}),
    };
  }
}
