import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';
import type { ContentCandidate, ContentClient, ContentRequest } from './types.js';

/**
 * Deterministic offline content stub. No model, no network: it fills a
 * template from product info. It enforces the banned-word list so the
 * review path is exercised, and it never returns a 'confirmed' candidate
 * — human review (or M4 content-base review) is the only way to confirm.
 */
export class StubContentClient implements ContentClient {
  readonly source = 'stub' as const;
  private readonly candidates = new Map<string, ContentCandidate>();

  async request(input: ContentRequest): Promise<ContentCandidate> {
    const title = String(input.inputs.title ?? input.productId);
    const sellingPoints = Array.isArray(input.inputs.sellingPoints)
      ? (input.inputs.sellingPoints as unknown[]).map(String)
      : [];
    const banned = input.constraints?.banned ?? [];
    const text = [
      `${title}`,
      sellingPoints.length ? sellingPoints.map((p) => `· ${p}`).join('\n') : '· 卖点待补充',
      `（${input.channel} 沙箱内容桩生成，待人工审核）`,
    ].join('\n');

    const bannedHit = banned.find((word) => text.includes(word));
    if (bannedHit) {
      throw new CommerceError(
        'VALIDATION_FAILED',
        `stub content contains banned word '${bannedHit}'; refusing to produce candidate`,
        false,
        { bannedWord: bannedHit },
      );
    }

    const candidate: ContentCandidate = {
      id: newId('cc'),
      productId: input.productId,
      channel: input.channel,
      contentType: input.contentType,
      body: { title, text },
      status: 'pending_review',
      evidenceRefs: [`stub:${input.productId}`],
      source: 'stub',
      createdAt: nowIso(),
    };
    this.candidates.set(candidate.id, candidate);
    return candidate;
  }

  async review(id: string, decision: 'confirmed' | 'modified' | 'rejected', finalBody?: ContentCandidate['body']): Promise<ContentCandidate> {
    const candidate = this.candidates.get(id);
    if (!candidate) throw new CommerceError('NOT_FOUND', `content candidate not found: ${id}`, false, { contentId: id });
    if (candidate.status !== 'pending_review') {
      throw new CommerceError('CONFLICT', `content already reviewed: ${candidate.status}`, false, { status: candidate.status });
    }
    if (decision === 'modified' && !finalBody) {
      throw new CommerceError('VALIDATION_FAILED', 'modified review requires finalBody');
    }
    const updated: ContentCandidate = {
      ...candidate,
      status: decision,
      ...(decision === 'modified' && finalBody ? { body: finalBody } : {}),
    };
    this.candidates.set(id, updated);
    return updated;
  }

  get(id: string): ContentCandidate | undefined {
    return this.candidates.get(id);
  }
}
