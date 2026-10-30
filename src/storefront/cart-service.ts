import type { StorageDriver } from '../storage/driver.js';
import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';

/**
 * Storefront cart service (SF-03, Tier0-独立站双用 v1.0 §5.3).
 * Anonymous session cart: line-level validation (listed product, active SKU,
 * positive qty) and a unit-amount snapshot in micros taken at first add —
 * later price changes never rewrite existing lines (改价不追溯).
 */

export interface Cart {
  id: string;
  merchantId: string;
  channel: string;
  status: 'open' | 'checked_out' | 'abandoned';
  createdAt: string;
}

export interface CartItem {
  id: string;
  cartId: string;
  productId: string;
  skuId: string;
  skuCode: string;
  qty: number;
  unitAmountMicros: number;
  currency: string;
}

export interface AddItemInput {
  productId: string;
  skuId: string;
  qty: number;
}

function validationError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('VALIDATION_FAILED', message, false, details);
}
function notFoundError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('NOT_FOUND', message, false, details);
}

function microsFromPrice(price: number): number {
  return Math.round(price * 1_000_000);
}

export class CartService {
  constructor(private readonly driver: StorageDriver) {}

  async createCart(input: { merchantId: string; channel?: string }): Promise<Cart> {
    if (!input.merchantId?.trim()) throw validationError('cart.merchantId is required');
    const cart: Cart = {
      id: newId('cart'),
      merchantId: input.merchantId.trim(),
      channel: input.channel ?? 'storefront',
      status: 'open',
      createdAt: nowIso(),
    };
    await this.driver.run(
      `INSERT INTO carts (id, merchant_id, channel, status, created_at) VALUES (?, ?, ?, ?, ?)`,
      [cart.id, cart.merchantId, cart.channel, cart.status, cart.createdAt],
    );
    return cart;
  }

  async getCart(cartId: string): Promise<Cart> {
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM carts WHERE id = ?', [cartId]);
    if (!row) throw notFoundError(`cart not found: ${cartId}`, { cartId });
    return this.mapCart(row);
  }

  async listItems(cartId: string): Promise<CartItem[]> {
    await this.getCart(cartId);
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT ci.*, s.sku_code, s.currency FROM cart_items ci JOIN skus s ON s.id = ci.sku_id
       WHERE ci.cart_id = ? ORDER BY ci.id ASC`,
      [cartId],
    );
    return rows.map((r) => this.mapItem(r));
  }

  /**
   * Add or merge a line. Re-adding the same SKU merges qty but keeps the
   * original unit-amount snapshot (改价不追溯).
   */
  async addItem(cartId: string, input: AddItemInput): Promise<CartItem[]> {
    const cart = await this.getCart(cartId);
    if (cart.status !== 'open') throw validationError(`cart is not open: ${cartId}`, { cartId, status: cart.status });
    if (!input.productId?.trim() || !input.skuId?.trim()) throw validationError('addItem requires productId and skuId');
    if (!Number.isInteger(input.qty) || input.qty <= 0) throw validationError(`qty must be a positive integer: ${input.qty}`);

    const product = await this.driver.get<Record<string, unknown>>('SELECT status FROM products WHERE id = ?', [input.productId]);
    if (!product) throw notFoundError(`product not found: ${input.productId}`, { productId: input.productId });
    if (product.status !== 'listed') throw validationError(`product is not listed: ${input.productId}`, { productId: input.productId });

    const sku = await this.driver.get<Record<string, unknown>>(
      `SELECT id, product_id, sku_code, price, currency, status FROM skus WHERE id = ? AND status = 'active'`,
      [input.skuId],
    );
    if (!sku) throw notFoundError(`active sku not found: ${input.skuId}`, { skuId: input.skuId });
    if (String(sku.product_id) !== input.productId) {
      throw validationError(`sku does not belong to product: ${input.skuId}`, { skuId: input.skuId, productId: input.productId });
    }

    const existing = await this.driver.get<Record<string, unknown>>(
      'SELECT id, qty FROM cart_items WHERE cart_id = ? AND sku_id = ?',
      [cartId, input.skuId],
    );
    if (existing) {
      await this.driver.run('UPDATE cart_items SET qty = ? WHERE id = ?', [Number(existing.qty) + input.qty, String(existing.id)]);
    } else {
      const item: CartItem = {
        id: newId('ci'),
        cartId,
        productId: input.productId,
        skuId: input.skuId,
        skuCode: String(sku.sku_code),
        qty: input.qty,
        unitAmountMicros: microsFromPrice(Number(sku.price)),
        currency: String(sku.currency),
      };
      await this.driver.run(
        `INSERT INTO cart_items (id, cart_id, product_id, sku_id, qty, unit_amount_micros)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [item.id, item.cartId, item.productId, item.skuId, item.qty, item.unitAmountMicros],
      );
    }
    return this.listItems(cartId);
  }

  private mapCart(r: Record<string, unknown>): Cart {
    return {
      id: String(r.id),
      merchantId: String(r.merchant_id),
      channel: String(r.channel),
      status: r.status as Cart['status'],
      createdAt: String(r.created_at),
    };
  }

  private mapItem(r: Record<string, unknown>): CartItem {
    return {
      id: String(r.id),
      cartId: String(r.cart_id),
      productId: String(r.product_id),
      skuId: String(r.sku_id),
      skuCode: String(r.sku_code),
      qty: Number(r.qty),
      unitAmountMicros: Number(r.unit_amount_micros),
      currency: String(r.currency),
    };
  }
}
