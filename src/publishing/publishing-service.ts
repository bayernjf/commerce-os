import { CommerceError } from '../util/errors.js';
import type { EventLog } from '../storage/event-log.js';
import type { DecisionPort } from '../decision/types.js';
import type { ChannelRegistry } from '../channel/registry.js';
import type { ChannelAccountService } from '../channel/channel-account-service.js';
import type { ProductService } from '../product/product-service.js';
import type { ContentCandidate, ContentClient } from '../content/types.js';

export interface ListingSubmission {
  productId: string;
  channelAccountId: string;
  content: ContentCandidate;
  decisionId: string;
  grade: string;
  status: 'awaiting_approval' | 'listed';
  externalProductId?: string;
  externalContentId?: string;
}

/**
 * Listing orchestration (design §6.3). Publishing to a channel is an
 * external-facing action, so zeus grades it (D3 under the default policy)
 * and the channel is only touched after a human approval:
 *
 *   submitListing:  stub content → zeus decision → park (held)
 *   approveListing: approval → review/confirm content → upsert product →
 *                   publish content → store external refs
 *
 * Nothing is sent to the channel before an approval.
 */
export class PublishingService {
  constructor(
    private readonly events: EventLog,
    private readonly decisions: DecisionPort,
    private readonly registry: ChannelRegistry,
    private readonly accounts: ChannelAccountService,
    private readonly products: ProductService,
    private readonly content: ContentClient,
  ) {}

  async submitListing(input: {
    productId: string;
    channelAccountId: string;
    contentType?: ContentCandidate['contentType'];
    sellingPoints?: string[];
    constraints?: { banned?: string[]; brand?: string[] };
  }): Promise<ListingSubmission> {
    const product = await this.products.getProduct(input.productId);
    const account = await this.accounts.get(input.channelAccountId);
    const adapter = this.registry.get(account.channel);

    // 1. Content candidate (stub in M3, loom content-base in M4).
    const candidate = await this.content.request({
      productId: product.id,
      channel: account.channel,
      contentType: input.contentType ?? 'detail',
      inputs: { title: product.title, sellingPoints: input.sellingPoints ?? [] },
      ...(input.constraints ? { constraints: input.constraints } : {}),
    });

    // 2. Decision: publishing is external and (by default) irreversible.
    const decision = await this.decisions.decide({
      intent: 'product.publish',
      domain: 'commerce',
      impact: 'external',
      reversibility: 'irreversible',
      riskTags: ['listing', adapter.channel],
      proposal: `publish ${product.title} on ${account.channel} (${candidate.contentType})`,
      idempotencyKey: `listing:${product.id}:${account.channel}`,
    });
    await this.events.record({
      eventType: 'decision.requested',
      refType: 'product',
      refId: product.id,
      decisionId: decision.decisionId,
      payload: { channelAccountId: account.id, channel: account.channel, contentId: candidate.id, grade: decision.grade },
    });

    if (decision.status === 'decided') {
      return this.executeListing(product.id, account.id, candidate.id, decision.decisionId);
    }

    return {
      productId: product.id,
      channelAccountId: account.id,
      content: candidate,
      decisionId: decision.decisionId,
      grade: decision.grade,
      status: 'awaiting_approval',
    };
  }

  async approveListing(decisionId: string, approver: string, comment?: string): Promise<ListingSubmission> {
    const requested = await this.events.list({ eventType: 'decision.requested' });
    const event = requested.find((e) => e.decisionId === decisionId);
    if (!event || event.refType !== 'product' || !event.refId) {
      throw new CommerceError('NOT_FOUND', `no pending listing found for decision ${decisionId}`);
    }
    const productId = event.refId;
    const channelAccountId = String(event.payload.channelAccountId);
    const contentId = String(event.payload.contentId);

    const decision = await this.decisions.approve(decisionId, approver, comment);
    if (decision.status === 'rejected') {
      throw new CommerceError('CONFLICT', `listing decision was rejected: ${decisionId}`, false, { decisionId });
    }
    return this.executeListing(productId, channelAccountId, contentId, decisionId);
  }

  async rejectListing(decisionId: string, approver: string, comment?: string): Promise<{ decisionId: string; status: 'rejected' }> {
    await this.decisions.reject(decisionId, approver, comment);
    await this.events.record({
      eventType: 'listing.rejected',
      refType: 'product',
      decisionId,
      payload: { approver, comment: comment ?? null },
    });
    return { decisionId, status: 'rejected' };
  }

  private async executeListing(productId: string, channelAccountId: string, contentId: string, decisionId: string): Promise<ListingSubmission> {
    const product = await this.products.getProduct(productId);
    const account = await this.accounts.get(channelAccountId);
    const adapter = this.registry.get(account.channel);

    // Content review → confirmed (M3: listing approval implies content approval).
    const candidate = await this.content.review(contentId, 'confirmed');

    // Upsert product on the channel.
    const productRef = await adapter.upsertProduct({
      ...(product.externalRef ? { channelProductId: product.externalRef } : {}),
      title: product.title,
      skus: product.skus.map((s) => ({ skuCode: s.skuCode, specs: s.specs, price: s.price, currency: s.currency })),
    });
    await this.products.setExternalRef(product.id, productRef.externalProductId);

    // Publish content.
    const published = await adapter.publish({
      externalProductId: productRef.externalProductId,
      title: candidate.body.title,
      body: candidate.body,
      contentType: candidate.contentType,
    });

    await this.events.record({
      eventType: 'product.listed',
      refType: 'product',
      refId: product.id,
      decisionId,
      payload: {
        externalProductId: productRef.externalProductId,
        externalContentId: published.externalContentId,
        channel: account.channel,
      },
    });

    return {
      productId,
      channelAccountId,
      content: candidate,
      decisionId,
      grade: 'D3',
      status: 'listed',
      externalProductId: productRef.externalProductId,
      externalContentId: published.externalContentId,
    };
  }
}
