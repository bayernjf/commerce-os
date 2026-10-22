import type { StorageDriver } from '../storage/driver.js';
import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';

function validationError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('VALIDATION_FAILED', message, false, details);
}
function notFoundError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('NOT_FOUND', message, false, details);
}
function conflictError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('IDEMPOTENCY_CONFLICT', message, false, details);
}

export interface Category {
  id: string;
  channel?: string;
  name: string;
  parentId?: string;
  attributes: string[];
  createdAt: string;
}

export interface Sku {
  id: string;
  productId: string;
  skuCode: string;
  specs: Record<string, unknown>;
  price: number;
  currency: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  channelAccountId?: string;
  externalRef?: string;
  title: string;
  categoryId?: string;
  status: 'draft' | 'listed' | 'delisted';
  attributes: Record<string, unknown>;
  skus: Sku[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSkuInput {
  skuCode: string;
  specs?: Record<string, unknown>;
  price: number;
  currency?: string;
}

export interface CreateProductInput {
  title: string;
  categoryId?: string;
  channelAccountId?: string;
  attributes?: Record<string, unknown>;
  skus: CreateSkuInput[];
}

export class ProductService {
  constructor(private readonly driver: StorageDriver) {}

  async createCategory(input: { name: string; channel?: string; parentId?: string; attributes?: string[] }): Promise<Category> {
    if (!input.name?.trim()) throw validationError('category.name is required');
    if (input.parentId) {
      const parent = await this.driver.get('SELECT id FROM categories WHERE id = ?', [input.parentId]);
      if (!parent) throw validationError(`parent category not found: ${input.parentId}`, { parentId: input.parentId });
    }
    const cat: Category = {
      id: newId('cat', input.name),
      ...(input.channel ? { channel: input.channel } : {}),
      name: input.name.trim(),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      attributes: input.attributes ?? [],
      createdAt: nowIso(),
    };
    await this.driver.run(
      `INSERT INTO categories (id, channel, name, parent_id, attributes_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [cat.id, cat.channel ?? null, cat.name, cat.parentId ?? null, JSON.stringify(cat.attributes), cat.createdAt],
    );
    return cat;
  }

  async listCategories(): Promise<Category[]> {
    const rows = await this.driver.all<Record<string, unknown>>('SELECT * FROM categories ORDER BY created_at ASC');
    return rows.map((r) => this.mapCategory(r));
  }

  async createProduct(input: CreateProductInput): Promise<Product> {
    if (!input.title?.trim()) throw validationError('product.title is required');
    if (!Array.isArray(input.skus) || input.skus.length === 0) {
      throw validationError('product requires at least one SKU');
    }
    for (const sku of input.skus) {
      if (!sku.skuCode?.trim()) throw validationError('sku.skuCode is required');
      if (typeof sku.price !== 'number' || sku.price < 0) throw validationError(`sku.price must be a non-negative number: ${sku.skuCode}`);
      if (sku.currency && !/^[A-Z]{3}$/.test(sku.currency)) throw validationError(`sku.currency must be ISO 4217: ${sku.skuCode}`);
      const existing = await this.driver.get('SELECT id FROM skus WHERE sku_code = ?', [sku.skuCode]);
      if (existing) throw conflictError(`skuCode already exists: ${sku.skuCode}`, { skuCode: sku.skuCode });
    }
    if (input.categoryId) {
      const cat = await this.driver.get('SELECT id FROM categories WHERE id = ?', [input.categoryId]);
      if (!cat) throw validationError(`category not found: ${input.categoryId}`, { categoryId: input.categoryId });
    }
    if (input.channelAccountId) {
      const acc = await this.driver.get('SELECT id FROM channel_accounts WHERE id = ?', [input.channelAccountId]);
      if (!acc) throw validationError(`channel account not found: ${input.channelAccountId}`, { channelAccountId: input.channelAccountId });
    }
    const now = nowIso();
    const product: Product = {
      id: newId('prd', input.title),
      ...(input.channelAccountId ? { channelAccountId: input.channelAccountId } : {}),
      title: input.title.trim(),
      ...(input.categoryId ? { categoryId: input.categoryId } : {}),
      status: 'draft',
      attributes: input.attributes ?? {},
      skus: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.driver.run(
      `INSERT INTO products (id, channel_account_id, external_ref, title, category_id, status, attributes_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [product.id, product.channelAccountId ?? null, null, product.title, product.categoryId ?? null, product.status, JSON.stringify(product.attributes), product.createdAt, product.updatedAt],
    );
    for (const skuInput of input.skus) {
      const sku: Sku = {
        id: newId('sku', skuInput.skuCode),
        productId: product.id,
        skuCode: skuInput.skuCode,
        specs: skuInput.specs ?? {},
        price: skuInput.price,
        currency: skuInput.currency ?? 'CNY',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      product.skus.push(sku);
      await this.driver.run(
        `INSERT INTO skus (id, product_id, sku_code, specs_json, price, currency, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sku.id, sku.productId, sku.skuCode, JSON.stringify(sku.specs), sku.price, sku.currency, sku.status, sku.createdAt, sku.updatedAt],
      );
    }
    return product;
  }

  async getProduct(id: string): Promise<Product> {
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM products WHERE id = ?', [id]);
    if (!row) throw notFoundError(`product not found: ${id}`, { productId: id });
    const skuRows = await this.driver.all<Record<string, unknown>>('SELECT * FROM skus WHERE product_id = ? ORDER BY sku_code ASC', [id]);
    return { ...this.mapProduct(row), skus: skuRows.map((r) => this.mapSku(r)) };
  }

  async listProducts(): Promise<Product[]> {
    const rows = await this.driver.all<Record<string, unknown>>('SELECT id FROM products ORDER BY created_at ASC');
    const products: Product[] = [];
    for (const r of rows) {
      products.push(await this.getProduct(String(r.id)));
    }
    return products;
  }

  async setExternalRef(productId: string, externalRef: string): Promise<void> {
    await this.driver.run('UPDATE products SET external_ref = ?, status = ?, updated_at = ? WHERE id = ?', [
      externalRef,
      'listed',
      new Date().toISOString(),
      productId,
    ]);
  }

  private mapCategory(r: Record<string, unknown>): Category {
    return {
      id: String(r.id),
      ...(r.channel ? { channel: String(r.channel) } : {}),
      name: String(r.name),
      ...(r.parent_id ? { parentId: String(r.parent_id) } : {}),
      attributes: safeParseArray(r.attributes_json),
      createdAt: String(r.created_at),
    };
  }

  private mapProduct(r: Record<string, unknown>): Omit<Product, 'skus'> & { skus: Sku[] } {
    return {
      id: String(r.id),
      ...(r.channel_account_id ? { channelAccountId: String(r.channel_account_id) } : {}),
      ...(r.external_ref ? { externalRef: String(r.external_ref) } : {}),
      title: String(r.title),
      ...(r.category_id ? { categoryId: String(r.category_id) } : {}),
      status: r.status as Product['status'],
      attributes: safeParseObject(r.attributes_json),
      skus: [],
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private mapSku(r: Record<string, unknown>): Sku {
    return {
      id: String(r.id),
      productId: String(r.product_id),
      skuCode: String(r.sku_code),
      specs: safeParseObject(r.specs_json),
      price: Number(r.price),
      currency: String(r.currency),
      status: String(r.status),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
}

function safeParseArray(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function safeParseObject(raw: unknown): Record<string, unknown> {
  try {
    const v = JSON.parse(String(raw ?? '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
