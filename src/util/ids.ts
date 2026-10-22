import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Application-generated id with a readable prefix. Non-latin or unsafe
 * slugs fall back to a hash digest so ids stay URL-safe.
 */
export function newId(prefix: string, seed?: string): string {
  const random = randomBytes(6).toString('hex');
  if (!seed) return `${prefix}_${random}`;
  const slug = seed
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (/^[a-zA-Z0-9][\w.-]*$/.test(slug)) return `${prefix}_${slug}-${random.slice(0, 6)}`;
  return `${prefix}_${sha256Hex(seed).slice(0, 10)}-${random.slice(0, 6)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJsonArray(raw: string | null | undefined, fallback: unknown[]): unknown[] {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function parseJsonObject(raw: string | null | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fallback;
  } catch {
    return fallback;
  }
}
