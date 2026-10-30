// Server-side API client (SF-10). Runs only in Astro SSR; the browser never
// sees COMMERCE_API_BASE_URL or any ops token (token 复用家族体系 = SSR 端注入).
const API_BASE = process.env.COMMERCE_API_BASE_URL ?? 'http://127.0.0.1:8787';

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
  skus: CatalogSku[];
  listedAt: string;
}

export async function fetchCatalog(): Promise<CatalogItem[]> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/storefront/catalog`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { catalog?: CatalogItem[] };
    return data.catalog ?? [];
  } catch {
    return [];
  }
}

export async function fetchCatalogItem(id: string): Promise<CatalogItem | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/storefront/catalog/${id}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { item?: CatalogItem };
    return data.item ?? null;
  } catch {
    return null;
  }
}

export function formatPrice(price: number, currency: string): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 2 }).format(price);
}

export function lowestPrice(item: CatalogItem): number {
  return item.skus.reduce((min, s) => Math.min(min, s.price), Number.POSITIVE_INFINITY);
}
