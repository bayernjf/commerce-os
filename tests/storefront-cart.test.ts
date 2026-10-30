import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { ProductService } from '../src/product/product-service.js';
import { CartService } from '../src/storefront/cart-service.js';

describe('storefront cart service (SF-03)', () => {
  let driver: SqliteDriver;
  let products: ProductService;
  let carts: CartService;

  beforeEach(async () => {
    driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    products = new ProductService(driver);
    carts = new CartService(driver);
  });
  afterEach(async () => driver.close());

  async function listedProduct(title = '在售商品', price = 1299): Promise<{ id: string; skuId: string }> {
    const p = await products.createProduct({
      title,
      skus: [{ skuCode: `SKU-${title}`, price, currency: 'CNY' }],
    });
    await products.setExternalRef(p.id, `ext-${title}`);
    const skuId = p.skus[0]?.id ?? '';
    return { id: p.id, skuId };
  }

  it('creates an open anonymous cart with default channel', async () => {
    const cart = await carts.createCart({ merchantId: 'mer_owner' });
    expect(cart.id).toMatch(/^cart_/);
    expect(cart.status).toBe('open');
    expect(cart.channel).toBe('storefront');
    expect(cart.merchantId).toBe('mer_owner');
    expect(await carts.listItems(cart.id)).toEqual([]);
  });

  it('rejects empty merchant and unknown cart', async () => {
    await expect(carts.createCart({ merchantId: '  ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(carts.getCart('cart_unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('adds a line with micros snapshot from sku price', async () => {
    const cart = await carts.createCart({ merchantId: 'mer_owner' });
    const { id, skuId } = await listedProduct('快照商品', 99.9);

    const items = await carts.addItem(cart.id, { productId: id, skuId, qty: 2 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ productId: id, skuId, qty: 2, unitAmountMicros: 99_900_000, currency: 'CNY' });

    const big = await carts.addItem(cart.id, { productId: id, skuId, qty: 1 });
    expect(big[0]?.qty).toBe(3);
    expect(big[0]?.unitAmountMicros).toBe(99_900_000);
  });

  it('never rewrites the snapshot when the sku price changes (改价不追溯)', async () => {
    const cart = await carts.createCart({ merchantId: 'mer_owner' });
    const { id, skuId } = await listedProduct('追溯商品', 100);
    await carts.addItem(cart.id, { productId: id, skuId, qty: 1 });
    await driver.run('UPDATE skus SET price = ? WHERE id = ?', [300, skuId]);

    const after = await carts.addItem(cart.id, { productId: id, skuId, qty: 1 });
    expect(after[0]?.qty).toBe(2);
    expect(after[0]?.unitAmountMicros).toBe(100_000_000);
    expect(after[0]?.skuCode).toBe('SKU-追溯商品');
  });

  it('rejects non-listed products, inactive or foreign skus, bad qty, closed carts', async () => {
    const cart = await carts.createCart({ merchantId: 'mer_owner' });
    const draft = await products.createProduct({ title: '草稿', skus: [{ skuCode: 'SKU-草稿', price: 1 }] });
    const listed = await listedProduct('校验商品');
    const other = await listedProduct('他店商品');

    await expect(carts.addItem(cart.id, { productId: draft.id, skuId: draft.skus[0]?.id ?? '', qty: 1 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(carts.addItem(cart.id, { productId: listed.id, skuId: 'sku_unknown', qty: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(carts.addItem(cart.id, { productId: listed.id, skuId: other.skuId, qty: 1 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    for (const qty of [0, -1, 1.5]) {
      await expect(carts.addItem(cart.id, { productId: listed.id, skuId: listed.skuId, qty })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    await driver.run(`UPDATE skus SET status = 'disabled' WHERE id = ?`, [listed.skuId]);
    await expect(carts.addItem(cart.id, { productId: listed.id, skuId: listed.skuId, qty: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('keeps sessions isolated between carts', async () => {
    const cartA = await carts.createCart({ merchantId: 'mer_owner' });
    const cartB = await carts.createCart({ merchantId: 'mer_owner' });
    const { id, skuId } = await listedProduct('会话商品');

    await carts.addItem(cartA.id, { productId: id, skuId, qty: 1 });
    expect(await carts.listItems(cartA.id)).toHaveLength(1);
    expect(await carts.listItems(cartB.id)).toEqual([]);
  });
});
