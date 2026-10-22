import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { ProductService } from '../src/product/product-service.js';
import { CommerceError } from '../src/util/errors.js';

describe('product center (T-M3-03)', () => {
  let driver: SqliteDriver;
  let products: ProductService;

  beforeEach(async () => {
    driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    products = new ProductService(driver);
  });
  afterEach(async () => driver.close());

  it('creates a product with SKUs', async () => {
    const product = await products.createProduct({
      title: '测试商品',
      skus: [
        { skuCode: 'SKU-1', price: 1299, currency: 'CNY' },
        { skuCode: 'SKU-2', price: 99.9, specs: { color: '白' } },
      ],
    });
    expect(product.id).toMatch(/^prd_/);
    expect(product.status).toBe('draft');
    expect(product.skus).toHaveLength(2);
    expect(product.skus[0]?.currency).toBe('CNY');

    const fetched = await products.getProduct(product.id);
    expect(fetched.skus.map((s) => s.skuCode)).toEqual(['SKU-1', 'SKU-2']);
  });

  it('rejects empty title and SKU-less products', async () => {
    await expect(products.createProduct({ title: '  ', skus: [] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      products.createProduct({ title: 'x', skus: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects negative price and non-ISO currency', async () => {
    await expect(
      products.createProduct({ title: 'x', skus: [{ skuCode: 'A', price: -1 }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      products.createProduct({ title: 'x', skus: [{ skuCode: 'A', price: 1, currency: 'cny' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects duplicate skuCode', async () => {
    await products.createProduct({ title: 'p1', skus: [{ skuCode: 'DUP', price: 1 }] });
    await expect(
      products.createProduct({ title: 'p2', skus: [{ skuCode: 'DUP', price: 2 }] }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('creates categories with parent validation', async () => {
    const parent = await products.createCategory({ name: '数码' });
    const child = await products.createCategory({ name: '耳机', parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    await expect(
      products.createCategory({ name: 'bad', parentId: 'cat_missing' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('updates external ref and listed status', async () => {
    const product = await products.createProduct({ title: 'p', skus: [{ skuCode: 'S', price: 1 }] });
    await products.setExternalRef(product.id, 'dy-prd-1');
    const updated = await products.getProduct(product.id);
    expect(updated.externalRef).toBe('dy-prd-1');
    expect(updated.status).toBe('listed');
  });

  it('throws NOT_FOUND for missing products', async () => {
    try {
      await products.getProduct('prd_missing');
      throw new Error('should throw');
    } catch (err) {
      expect((err as CommerceError).code).toBe('NOT_FOUND');
    }
  });
});
