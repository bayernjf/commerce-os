import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';

/**
 * H5 (Tier0 review 2026-10-30): checkout approval is bound to the cart line
 * snapshot taken at checkout time. The cart stays open until payment, so a
 * drifted cart (qty, prices on newly added lines, added lines, currency) must
 * refuse the approval (409 CONFLICT), close the stale checkout, emit
 * checkout.approve_blocked, and let the shopper re-initiate with a fresh
 * decision. Legacy rows without snapshot columns are refused as well.
 */
describe('storefront checkout approval bound to cart snapshot (H5)', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => teardownHarness(h));

  async function cartWithItem(price = 1299): Promise<{ cartId: string; productId: string; skuId: string }> {
    const product = await h.services.products.createProduct({
      title: '快照商品',
      skus: [{ skuCode: 'SKU-SNAP-1', price, currency: 'CNY' }],
    });
    await h.services.products.setExternalRef(product.id, 'ext-snap-1');
    const cart = await h.services.storefrontCarts.createCart({ merchantId: 'mer_owner' });
    await h.services.storefrontCarts.addItem(cart.id, { productId: product.id, skuId: product.skus[0]?.id ?? '', qty: 1 });
    return { cartId: cart.id, productId: product.id, skuId: product.skus[0]?.id ?? '' };
  }

  async function pendingCheckout(cartId: string): Promise<{ checkoutId: string; decisionId: string }> {
    const checkout = await h.services.storefrontCheckouts.checkout(cartId);
    expect(checkout.status).toBe('pending');
    return { checkoutId: checkout.id, decisionId: checkout.decisionId ?? '' };
  }

  async function blockedEvents(): Promise<{ refId?: string; payload: Record<string, unknown> }[]> {
    return h.services.events.list({ eventType: 'checkout.approve_blocked' });
  }

  it('approves to paid when the cart still matches the snapshot', async () => {
    const { cartId } = await cartWithItem(1299);
    const { decisionId } = await pendingCheckout(cartId);

    const paid = await h.services.storefrontCheckouts.approveCheckout(decisionId, 'owner');

    expect(paid.status).toBe('paid');
    expect(paid.totalMicros).toBe(1299_000_000);
    expect(await blockedEvents()).toHaveLength(0);
    const cart = await h.services.storefrontCarts.getCart(cartId);
    expect(cart.status).toBe('checked_out');
  });

  it('refuses approval when qty drifted after checkout, then re-checkout gets a fresh decision', async () => {
    const { cartId, productId, skuId } = await cartWithItem(1299);
    const { checkoutId, decisionId } = await pendingCheckout(cartId);

    // Drift: shopper adds the same SKU again → qty 1 → 2 (merged line).
    await h.services.storefrontCarts.addItem(cartId, { productId, skuId, qty: 1 });

    await expect(h.services.storefrontCheckouts.approveCheckout(decisionId, 'owner')).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // Stale checkout is closed, cart stays open for a fresh attempt.
    const stale = await h.services.storefrontCheckouts.getCheckout(checkoutId);
    expect(stale.status).toBe('rejected');
    const cart = await h.services.storefrontCarts.getCart(cartId);
    expect(cart.status).toBe('open');

    const events = await blockedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.refId).toBe(checkoutId);
    expect(events[0]?.payload).toMatchObject({
      decisionId,
      reason: 'cart-lines-changed-since-checkout',
      approvedTotalMicros: 1299_000_000,
      currentTotalMicros: 2598_000_000,
    });

    // Re-initiate: a NEW checkout with a NEW decision, which approves fine.
    const fresh = await h.services.storefrontCheckouts.checkout(cartId);
    expect(fresh.id).not.toBe(checkoutId);
    expect(fresh.decisionId).toBeTruthy();
    expect(fresh.decisionId).not.toBe(decisionId);
    expect(fresh.status).toBe('pending');

    const paid = await h.services.storefrontCheckouts.approveCheckout(fresh.decisionId ?? '', 'owner');
    expect(paid.status).toBe('paid');
    expect(paid.totalMicros).toBe(2598_000_000);
  });

  it('refuses approval when an existing line was repriced after checkout', async () => {
    const { cartId } = await cartWithItem(1299);
    const { checkoutId, decisionId } = await pendingCheckout(cartId);

    // Repricing an existing cart line never rewrites it via the cart service
    // (改价不追溯), so simulate the drift at the storage level.
    await h.driver.run('UPDATE cart_items SET unit_amount_micros = ? WHERE cart_id = ?', [999_000_000, cartId]);

    await expect(h.services.storefrontCheckouts.approveCheckout(decisionId, 'owner')).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const stale = await h.services.storefrontCheckouts.getCheckout(checkoutId);
    expect(stale.status).toBe('rejected');
    const events = await blockedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      reason: 'cart-lines-changed-since-checkout',
      approvedTotalMicros: 1299_000_000,
      currentTotalMicros: 999_000_000,
    });
  });

  it('refuses approval when a new line was added after checkout', async () => {
    const { cartId } = await cartWithItem(1299);
    const { decisionId } = await pendingCheckout(cartId);

    const other = await h.services.products.createProduct({
      title: '追加商品',
      skus: [{ skuCode: 'SKU-SNAP-2', price: 10, currency: 'CNY' }],
    });
    await h.services.products.setExternalRef(other.id, 'ext-snap-2');
    await h.services.storefrontCarts.addItem(cartId, { productId: other.id, skuId: other.skus[0]?.id ?? '', qty: 1 });

    await expect(h.services.storefrontCheckouts.approveCheckout(decisionId, 'owner')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await blockedEvents()).toHaveLength(1);
  });

  it('refuses approval when the line currency drifted', async () => {
    const { cartId } = await cartWithItem(1299);
    const { decisionId } = await pendingCheckout(cartId);

    await h.driver.run(`UPDATE skus SET currency = 'USD' WHERE id = ?`, [await lineSkuId(cartId)]);

    await expect(h.services.storefrontCheckouts.approveCheckout(decisionId, 'owner')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const events = await blockedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.reason).toBe('cart-lines-changed-since-checkout');
  });

  it('refuses legacy rows without snapshot columns and requires a re-checkout', async () => {
    const { cartId } = await cartWithItem(1299);
    const { checkoutId, decisionId } = await pendingCheckout(cartId);

    // Simulate a pre-005 row: snapshot columns are NULL.
    await h.driver.run(
      `UPDATE checkouts SET total_micros = NULL, currency = NULL, lines_digest = NULL WHERE id = ?`,
      [checkoutId],
    );

    await expect(h.services.storefrontCheckouts.approveCheckout(decisionId, 'owner')).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const stale = await h.services.storefrontCheckouts.getCheckout(checkoutId);
    expect(stale.status).toBe('rejected');
    const events = await blockedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      decisionId,
      reason: 'cart-lines-changed-since-checkout',
      approvedTotalMicros: null,
      currentTotalMicros: 1299_000_000,
    });

    // Re-initiate works and stores the snapshot again.
    const fresh = await h.services.storefrontCheckouts.checkout(cartId);
    expect(fresh.id).not.toBe(checkoutId);
    expect(fresh.status).toBe('pending');
  });

  it('re-checkout after an explicit rejection requests a fresh decision', async () => {
    const { cartId } = await cartWithItem(1299);
    const { checkoutId, decisionId } = await pendingCheckout(cartId);

    await h.services.storefrontCheckouts.rejectCheckout(decisionId, 'owner');

    const fresh = await h.services.storefrontCheckouts.checkout(cartId);
    expect(fresh.id).not.toBe(checkoutId);
    expect(fresh.decisionId).toBeTruthy();
    expect(fresh.decisionId).not.toBe(decisionId);
    expect(fresh.status).toBe('pending');
  });

  async function lineSkuId(cartId: string): Promise<string> {
    const rows = await h.driver.all<{ sku_id: string }>('SELECT sku_id FROM cart_items WHERE cart_id = ?', [cartId]);
    return String(rows[0]?.sku_id);
  }
});
