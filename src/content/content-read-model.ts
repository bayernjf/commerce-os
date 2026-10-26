import { CommerceError } from '../util/errors.js';
import type { EventLog, CommerceEvent } from '../storage/event-log.js';

/**
 * A published-content record projected from the local audit trail. This is a
 * read model, not a channel call: the shape mirrors what the console used to
 * derive ad hoc from `GET /api/v1/events?eventType=product.listed` plus the
 * dashboard `content.published` basis.
 */
export interface ContentRecord {
  /** Channel-side content id (product.listed event payload.externalContentId). */
  id: string;
  /** Local SPU id the content was published for (event refId). */
  productId: string;
  channel: string;
  externalProductId: string;
  decisionId?: string;
  listedAt: string;
}

/**
 * Read-only published-content projection (T-M8 gap closure). Aggregation is
 * done in JS over persisted events so the queries stay dialect-portable;
 * nothing here touches the channel or writes any row.
 */
export class ContentReadModel {
  constructor(private readonly events: EventLog) {}

  async listContent(): Promise<ContentRecord[]> {
    const listed = await this.events.list({ eventType: 'product.listed' });
    return listed
      .filter((e) => Boolean(e.refId) && typeof e.payload.externalContentId === 'string')
      .map((e) => this.mapRecord(e));
  }

  async getContent(id: string): Promise<ContentRecord> {
    const all = await this.listContent();
    const record = all.find((r) => r.id === id);
    if (!record) throw new CommerceError('NOT_FOUND', `content not found: ${id}`, false, { contentId: id });
    return record;
  }

  private mapRecord(e: CommerceEvent): ContentRecord {
    return {
      id: String(e.payload.externalContentId),
      productId: String(e.refId),
      channel: String(e.payload.channel ?? ''),
      externalProductId: String(e.payload.externalProductId ?? ''),
      ...(e.decisionId ? { decisionId: e.decisionId } : {}),
      listedAt: e.createdAt,
    };
  }
}
