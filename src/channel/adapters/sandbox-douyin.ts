import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommerceError } from '../../util/errors.js';
import { nowIso } from '../../util/ids.js';
import type {
  ChannelAdapter,
  ChannelInventory,
  ChannelOrder,
  ExternalProductRef,
  PublishRequest,
  PublishResult,
  RefundRequest,
  RefundResult,
} from '../types.js';

interface SandboxFixtures {
  channel: string;
  recordedAt: string;
  note: string;
  upsertProduct: { externalProductId: string; externalSkuIdPrefix: string };
  orders: ChannelOrder[];
  inventory: ChannelInventory[];
  refund: { externalRefundId: string; status: RefundResult['status'] };
  publish: { externalContentId: string; status: PublishResult['status']; url?: string };
}

function resolveFixturesPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.COMMERCE_SANDBOX_FIXTURES,
    // compiled: dist/channel/adapters/ → repo root = ../../../
    join(here, '..', '..', '..', 'recordings', 'sandbox-douyin', 'fixtures.json'),
    // source: src/channel/adapters/ → repo root = ../../../../
    join(here, '..', '..', '..', '..', 'recordings', 'sandbox-douyin', 'fixtures.json'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new CommerceError('CHANNEL_UNAVAILABLE', 'sandbox fixtures not found; recordings/sandbox-douyin/fixtures.json is required', true);
}

/**
 * Offline sandbox adapter for the first channel (PRD §11: no real shop yet,
 * candidate is douyin). Replays recorded fixtures deterministically, never
 * opens a network connection. A real `douyin` adapter is a later slice that
 * requires credentials; until then any non-sandbox channel name fails closed
 * with CREDENTIAL_MISSING at configuration time.
 */
export class SandboxDouyinAdapter implements ChannelAdapter {
  readonly channel = 'sandbox-douyin';
  readonly sandbox = true;
  private readonly fixtures: SandboxFixtures;

  constructor(fixturesPath?: string) {
    const path = fixturesPath ?? resolveFixturesPath();
    if (!existsSync(path)) {
      throw new CommerceError(
        'CHANNEL_UNAVAILABLE',
        `sandbox fixtures not found: ${path} (recordings/sandbox-douyin/fixtures.json is required)`,
        true,
        { path },
      );
    }
    this.fixtures = JSON.parse(readFileSync(path, 'utf8')) as SandboxFixtures;
  }

  async upsertProduct(product: {
    channelProductId?: string;
    title: string;
    skus: { skuCode: string; specs: Record<string, unknown>; price: number; currency: string }[];
  }): Promise<ExternalProductRef> {
    const f = this.fixtures.upsertProduct;
    return {
      channel: this.channel,
      externalProductId: product.channelProductId ?? f.externalProductId,
      externalSkuRefs: product.skus.map((s, i) => ({
        skuCode: s.skuCode,
        externalSkuId: `${f.externalSkuIdPrefix}-${1000 + i}`,
      })),
      listedAt: nowIso(),
    };
  }

  async listOrders(query?: { since?: string }): Promise<ChannelOrder[]> {
    const since = query?.since ? Date.parse(query.since) : Number.NEGATIVE_INFINITY;
    return this.fixtures.orders.filter((o) => Date.parse(o.createdAt) >= since).map((o) => structuredClone(o));
  }

  async getInventory(skuCodes: string[]): Promise<ChannelInventory[]> {
    const wanted = new Set(skuCodes);
    return this.fixtures.inventory.filter((i) => wanted.has(i.skuCode)).map((i) => structuredClone(i));
  }

  async createRefund(request: RefundRequest): Promise<RefundResult> {
    const order = this.fixtures.orders.find((o) => o.externalOrderId === request.externalOrderId);
    if (!order) {
      throw new CommerceError(
        'NOT_FOUND',
        `sandbox has no recorded order ${request.externalOrderId}`,
        false,
        { externalOrderId: request.externalOrderId },
      );
    }
    return {
      channel: this.channel,
      externalRefundId: this.fixtures.refund.externalRefundId,
      externalOrderId: request.externalOrderId,
      status: this.fixtures.refund.status,
    };
  }

  async publish(content: PublishRequest): Promise<PublishResult> {
    return {
      channel: this.channel,
      externalContentId: this.fixtures.publish.externalContentId,
      status: this.fixtures.publish.status,
      ...(this.fixtures.publish.url ? { url: this.fixtures.publish.url } : {}),
      raw: { title: content.title, contentType: content.contentType },
    };
  }
}
