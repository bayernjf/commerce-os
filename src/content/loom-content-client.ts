import { CommerceError } from '../util/errors.js';
import type { ContentCandidate, ContentClient, ContentRequest } from './types.js';

export interface LoomContentClientOptions {
  baseUrl: string;
  actorId?: string;
  timeoutMs?: number;
}

interface LoomView {
  candidate_id: string;
  product_id: string;
  channel: string;
  content_type: ContentRequest['contentType'];
  body: Record<string, unknown>;
  evidence_refs: string[];
  status: ContentCandidate['status'];
  created_at: string | null;
}

/**
 * Real ContentClient over loom content-base HTTP API (M4/T-M4-03, design
 * §4.5). commerce-os never grades or authors content locally; when loom is
 * unreachable or returns 5xx, the action fails closed with
 * CONTENT_UNAVAILABLE (503, retryable) rather than fabricating content.
 */
export class LoomContentClient implements ContentClient {
  readonly source = 'content-base' as const;
  private readonly baseUrl: string;
  private readonly actorId: string;
  private readonly timeoutMs: number;

  constructor(options: LoomContentClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.actorId = options.actorId ?? 'commerce-os';
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  async request(input: ContentRequest): Promise<ContentCandidate> {
    const view = await this.post(
      '/api/v1/content/requests',
      {
        product_id: input.productId,
        channel: input.channel,
        content_type: input.contentType,
        inputs: input.inputs,
        constraints: {
          wordlist: input.constraints?.wordlist ?? [],
          banned: input.constraints?.banned ?? [],
          brand: input.constraints?.brand ?? [],
        },
        actor: { id: this.actorId, roles: ['commerce'] },
      },
    );
    return this.map(view);
  }

  async review(
    id: string,
    decision: 'confirmed' | 'modified' | 'rejected',
    finalBody?: ContentCandidate['body'],
  ): Promise<ContentCandidate> {
    const view = await this.post(
      `/api/v1/content/${encodeURIComponent(id)}/review`,
      {
        decision,
        ...(finalBody ? { final_body: finalBody } : {}),
        actor: { id: this.actorId, roles: ['commerce'] },
      },
    );
    return this.map(view);
  }

  private map(view: LoomView): ContentCandidate {
    return {
      id: view.candidate_id,
      productId: view.product_id,
      channel: view.channel,
      contentType: view.content_type,
      body: {
        title: String(view.body.title ?? ''),
        text: String(view.body.text ?? ''),
      },
      status: view.status,
      evidenceRefs: view.evidence_refs,
      source: 'content-base',
      createdAt: view.created_at ?? new Date().toISOString(),
    };
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<LoomView> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new CommerceError(
        'CONTENT_UNAVAILABLE',
        `loom content call failed: ${(err as Error).message}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 404) throw new CommerceError('NOT_FOUND', `loom: ${text}`, false);
      if (res.status === 409) throw new CommerceError('CONFLICT', `loom: ${text}`, false);
      if (res.status === 422) throw new CommerceError('VALIDATION_FAILED', `loom: ${text}`, false);
      throw new CommerceError(
        'CONTENT_UNAVAILABLE',
        `loom content returned ${res.status}: ${text}`,
        true,
      );
    }
    return (await res.json()) as LoomView;
  }
}
