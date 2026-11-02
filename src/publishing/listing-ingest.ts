// commerce-os T-M9-01 (J1): ListingIngestPort — extract listing info from
// product images (VLM) or a product page URL (official platform API). The
// result feeds ContentRequest.inputs so the existing publish pipeline
// (content → zeus decision → channel upsert) stays byte-for-byte unchanged.
//
// Three-piece discipline (mirrors channel/adapters and growth-agent's
// ads/sentiment connectors):
//   - offline  -> deterministic OfflineListingIngest (no model/network).
//   - online   -> RejectingListingIngest (422 CREDENTIAL_MISSING) until the
//                 VLM model and official platform API credentials land.
//
// The real transports are a later OP: ingestFromImage needs a vision-language
// model in model-hub (none registered yet) and ingestFromUrl needs My Alibaba
// / official platform OpenAPI credentials. Selecting online therefore fails
// closed rather than silently fabricating listings.

import { CommerceError } from '../util/errors.js';

export interface ListingIngestResult {
  /** Extracted title; empty means "fall back to the product title". */
  title: string;
  /** Extracted selling points; empty means "keep the caller-supplied ones". */
  sellingPoints: string[];
  /** Extracted description / body. */
  description: string;
  /** Source evidence (image URLs / page URL). */
  evidenceRefs: string[];
}

export interface ListingIngestInput {
  productId: string;
  channel: string;
  /** ingestFromImage: product image URLs (VLM extraction). */
  imageUrls?: string[];
  /** ingestFromUrl: product page URL (official platform API extraction). */
  url?: string;
}

export interface ListingIngestPort {
  readonly name: string;
  readonly mode: 'offline' | 'online';
  ingest(input: ListingIngestInput): Promise<ListingIngestResult>;
}

export class OfflineListingIngest implements ListingIngestPort {
  readonly name = 'listing-ingest-offline';
  readonly mode = 'offline' as const;

  async ingest(input: ListingIngestInput): Promise<ListingIngestResult> {
    const evidenceRefs: string[] = [];
    if (input.imageUrls?.length) evidenceRefs.push(...input.imageUrls);
    if (input.url) evidenceRefs.push(input.url);
    return {
      title: `商品 ${input.productId}`,
      sellingPoints: ['卖点待补充（离线 ingest 提取）'],
      description: `${input.channel} 导入商品 ${input.productId}（离线提取桩，待人工补充）`,
      evidenceRefs: evidenceRefs.length ? evidenceRefs : [`offline:${input.productId}`],
    };
  }
}

export class RejectingListingIngest implements ListingIngestPort {
  readonly name = 'listing-ingest-rejecting';
  readonly mode = 'online' as const;

  constructor(private readonly message: string) {}

  ingest(_input: ListingIngestInput): Promise<ListingIngestResult> {
    return Promise.reject(new CommerceError('CREDENTIAL_MISSING', this.message, false));
  }
}

export function createListingIngest(mode: 'offline' | 'online'): ListingIngestPort {
  if (mode === 'online') {
    return new RejectingListingIngest(
      'listing ingest online requires a vision-language model (ingestFromImage) and official platform API credentials (ingestFromUrl); neither is configured yet',
    );
  }
  return new OfflineListingIngest();
}
