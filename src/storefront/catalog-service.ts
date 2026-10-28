import type { StorageDriver } from '../storage/driver.js';
import { CommerceError } from '../util/errors.js';

/**
 * Read-only storefront catalog projection (SF-02, Tier0-独立站双用 v1.0 §5.3).
 * Only products in 'listed' status (i.e. approved by the publishing/decision
 * chain and upserted) are visible; drafts and delisted items never appear.
 * Dialect-portable queries only; nothing here writes or touches a channel.
 */

export interface CatalogSku {
  id: string;
  skuCode: string;
  price: number;
  currency: string;
  specs: Record<string, unknown>;
}

export interface CatalogItem {
  productId: string;
  title: string;
  categoryId?: string;
  skus: CatalogSku[];
  listedAt: string;
}

function notFoundError(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('NOT_FOUND', message, false, details);
}

export class StorefrontCatalogService {
  constructor(private readonly driver: StorageDriver) {}

  async listCatalog(): Promise<CatalogItem[]> {
    const rows = await this.driver.all<Record<string, unknown>>(
      `SELECT id FROM products WHERE status = 'listed' ORDER BY created_at ASC`,
    );
    const items: CatalogItem[] = [];
    for (const r of rows) {
      items.push(await this.getCatalogItem(String(r.id)));
    }
    return items;
  }

  async getCatalogItem(productId: string): Promise<CatalogItem> {
    const row = await this.driver.get<Record<string, unknown>>(
      `SELECT * FROM products WHERE id = ? AND status = 'listed'`,
      [productId],
    );
    if (!row) {
      throw notFoundError(`catalog item not found: ${productId}`, { productId });
    }
    const skuRows = await this.driver.all<Record<string, unknown>>(
      `SELECT * FROM skus WHERE product_id = ? AND status = 'active' ORDER BY sku_code ASC`,
      [productId],
    );
    return {
      productId: String(row.id),
      title: String(row.title),
      ...(row.category_id ? { categoryId: String(row.category_id) } : {}),
      skus: skuRows.map((r) => this.mapSku(r)),
      listedAt: String(row.updated_at),
    };
  }

  private mapSku(r: Record<string, unknown>): CatalogSku {
    return {
      id: String(r.id),
      skuCode: String(r.sku_code),
      price: Number(r.price),
      currency: String(r.currency),
      specs: safeParseObject(r.specs_json),
    };
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
