/**
 * Content client port (design §4.5). M3 ships a deterministic stub;
 * M4 replaces it with the loom content-base client without changing
 * callers (same request/candidate/review contract).
 */
export interface ContentRequest {
  productId: string;
  channel: string;
  contentType: 'detail' | 'post' | 'short_video_script' | 'qa';
  inputs: Record<string, unknown>;
  constraints?: { wordlist?: string[]; banned?: string[]; brand?: string[] };
}

export interface ContentCandidate {
  id: string;
  productId: string;
  channel: string;
  contentType: ContentRequest['contentType'];
  body: { title: string; text: string };
  status: 'pending_review' | 'confirmed' | 'modified' | 'rejected';
  evidenceRefs: string[];
  source: 'stub' | 'content-base';
  createdAt: string;
}

export interface ContentClient {
  readonly source: ContentCandidate['source'];
  request(input: ContentRequest): Promise<ContentCandidate>;
  review(id: string, decision: 'confirmed' | 'modified' | 'rejected', finalBody?: ContentCandidate['body']): Promise<ContentCandidate>;
}
