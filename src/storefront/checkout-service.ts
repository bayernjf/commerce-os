import type { StorageDriver } from '../storage/driver.js';
import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';
import type { CartService } from './cart-service.js';
import type { PaymentRegistry } from './payment-registry.js';
import type { OrderService } from '../order/order-service.js';

/**
 * Storefront checkout service (SF-04, Tier0-独立站双用 v1.0 §5.3).
 * Flow: cart validation → idempotent order creation (channel=storefront,
 * external_order_id=sf-{cartId}) → PaymentPort.create/confirm → state machine.
 * Re-checking out the same cart returns the existing checkout — never a
 * duplicate order. D3 decision gating (approved/rejected) lands in SF-09.
 */

export type CheckoutStatus = 'pending' | 'paid' | 'failed';

export interface Checkout {
  id: string;
  cartId: string;
  orderId: string;
  paymentId: string;
  provider: string;
  status: CheckoutStatus;
  totalMicros: number;
  currency: string;
  createdAt: string;
  decidedAt?: string;
}

function validationError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('VALIDATION_FAILED', message, false, details);
}
function notFoundError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('NOT_FOUND', message, false, details);
}

export class CheckoutService {
  constructor(
    private readonly driver: StorageDriver,
    private readonly carts: CartService,
    private readonly orders: OrderService,
    private readonly payments: PaymentRegistry,
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

    const port = this.payments.get(providerName);
    const order = await this.ensureOrder(cartId, lines, totalMicros, currency);

    const now = nowIso();
    const paymentId = newId('pay');
    await port.create({ paymentId, amountMicros: totalMicros, currency });
    const checkoutId = newId('cko');
    await this.driver.run(
      `INSERT INTO checkouts (id, merchant_id, cart_id, order_id, payment_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [checkoutId, cart.merchantId, cartId, order.id, paymentId, 'pending', now],
    );
    await this.driver.run(
      `INSERT INTO payments (id, checkout_id, provider, status, external_ref, amount_micros, raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [paymentId, checkoutId, port.provider, 'created', null, totalMicros, '{}', now, now],
    );

    const confirmed = await port.confirm(paymentId);
    const status: CheckoutStatus = confirmed.status === 'confirmed' ? 'paid' : 'failed';
    const decidedAt = nowIso();
    await this.driver.run(
      `UPDATE checkouts SET status = ?, decided_at = ? WHERE id = ?`,
      [status, decidedAt, checkoutId],
    );
    await this.driver.run(
      `UPDATE payments SET status = ?, external_ref = ?, updated_at = ? WHERE id = ?`,
      [confirmed.status, confirmed.externalRef ?? null, decidedAt, paymentId],
    );
    if (status === 'paid') {
      await this.orders.setStatus(order.id, 'paid');
      await this.driver.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);
    }

    return this.getCheckout(checkoutId);
  }

  async getCheckout(id: string): Promise<Checkout> {
    const row = await this.findRow('id', id);
    if (!row) throw notFoundError(`checkout not found: ${id}`, { checkoutId: id });
    return this.mapCheckout(row);
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
      orderId: String(r.order_id),
      paymentId: String(r.payment_id),
      provider: String(r.payment_provider ?? ''),
      status: r.status as CheckoutStatus,
      totalMicros: Number(r.payment_amount_micros ?? 0),
      currency: String(r.order_currency ?? ''),
      createdAt: String(r.created_at),
      ...(r.decided_at ? { decidedAt: String(r.decided_at) } : {}),
    };
  }
}
