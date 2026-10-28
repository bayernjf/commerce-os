import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { ProductService } from '../src/product/product-service.js';
import { StorefrontCatalogService } from '../src/storefront/catalog-service.js';

describe('storefront catalog projection (SF-02)', () => {
  let driver: SqliteDriver;
  let products: ProductService;
  let catalog: StorefrontCatalogService;

  beforeEach(async () => {
    driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    products = new ProductService(driver);
    catalog = new StorefrontCatalogService(driver);
  });
  afterEach(async () => driver.close());

  it('hides draft products from the projection', async () => {
    const p = await products.createProduct({
      title: '未上架商品',
      skus: [{ skuCode: 'SKU-D1', price: 100, currency: 'CNY' }],
    });
    expect(await catalog.listCatalog()).toEqual([]);
    await expect(catalog.getCatalogItem(p.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('exposes listed products with active SKUs only', async () => {
    const p = await products.createProduct({
      title: '已上架商品',
      skus: [
        { skuCode: 'SKU-A1', price: 1299, currency: 'CNY', specs: { color: '黑' } },
        { skuCode: 'SKU-A2', price: 99.9, currency: 'CNY' },
      ],
    });
    await products.setExternalRef(p.id, 'ext-1');

    const items = await catalog.listCatalog();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      productId: p.id,
      title: '已上架商品',
    });
    expect(items[0]?.skus.map((s) => s.skuCode)).toEqual(['SKU-A1', 'SKU-A2']);
    expect(items[0]?.skus[0]?.specs).toEqual({ color: '黑' });

    const one = await catalog.getCatalogItem(p.id);
    expect(one.productId).toBe(p.id);
    expect(one.skus[0]?.price).toBe(1299);
    expect(one.skus[0]?.currency).toBe('CNY');
  });

  it('filters out disabled SKUs from the projection', async () => {
    const p = await products.createProduct({
      title: '含停售 SKU 商品',
      skus: [
        { skuCode: 'SKU-B1', price: 10 },
        { skuCode: 'SKU-B2', price: 20 },
      ],
    });
    await products.setExternalRef(p.id, 'ext-2');
    await driver.run(`UPDATE skus SET status = 'disabled' WHERE sku_code = 'SKU-B2'`);

    const items = await catalog.listCatalog();
    expect(items[0]?.skus.map((s) => s.skuCode)).toEqual(['SKU-B1']);
  });

  it('keeps listed ordering by created_at and returns 404 for unknown id', async () => {
    const a = await products.createProduct({ title: '商品甲', skus: [{ skuCode: 'SKU-C1', price: 1 }] });
    const b = await products.createProduct({ title: '商品乙', skus: [{ skuCode: 'SKU-C2', price: 2 }] });
    await products.setExternalRef(a.id, 'ext-a');
    await products.setExternalRef(b.id, 'ext-b');

    const items = await catalog.listCatalog();
    expect(items.map((i) => i.title)).toEqual(['商品甲', '商品乙']);

    await expect(catalog.getCatalogItem('prd_unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
