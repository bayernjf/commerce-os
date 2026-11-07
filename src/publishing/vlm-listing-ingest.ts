// T-M9-01 (J1) online listing ingest backed by a vision-language model.
//
// The VLM receives the product images as multimodal chat content and returns
// strict JSON { title, sellingPoints, description }. It implements ONLY
// ingestFromImage; ingestFromUrl (official platform API) stays out of scope
// until those credentials exist, and this class never fabricates a result when
// the model call fails.
//
// The chat function is injected rather than constructing a ModelKit here so
// the adapter stays unit-testable with a scripted caller and the composition
// root (serve.ts) owns hub URL/token lifecycle.

import { CommerceError } from '../util/errors.js';
import type { ChatMessage, ContentPart } from '@model-hub/model-kit';
import type { ListingIngestInput, ListingIngestPort, ListingIngestResult } from './listing-ingest.js';

/** Minimal multimodal chat call the adapter needs; ModelKit.chat satisfies it. */
export type VlmChat = (messages: ChatMessage[]) => Promise<{ content: string }>;

interface VlmExtraction {
  title?: unknown;
  sellingPoints?: unknown;
  description?: unknown;
}

const SYSTEM_PROMPT =
  'You extract e-commerce listing information from product images. ' +
  'Answer with one JSON object exactly matching ' +
  '{"title":string,"sellingPoints":string[],"description":string}. ' +
  'Use the language of the product. Do not add markdown or any text outside the JSON.';

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CommerceError('VLM_BAD_PAYLOAD', `VLM returned an invalid or empty ${field}`, false);
  }
  return value.trim();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new CommerceError('VLM_BAD_PAYLOAD', 'VLM sellingPoints must be an array', false);
  }
  const points = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((s) => s.trim());
  if (points.length === 0) {
    throw new CommerceError('VLM_BAD_PAYLOAD', 'VLM returned no usable selling points', false);
  }
  return points;
}

export class VlmListingIngest implements ListingIngestPort {
  readonly name = 'listing-ingest-vlm';
  readonly mode = 'online' as const;

  constructor(private readonly chat: VlmChat) {}

  async ingest(input: ListingIngestInput): Promise<ListingIngestResult> {
    const imageUrls = input.imageUrls ?? [];
    if (imageUrls.length === 0) {
      // No image means there is nothing for a VLM to read; surface a clear
      // configuration/usage error rather than an empty or fabricated result.
      throw new CommerceError('VLM_NO_IMAGE', 'ingestFromImage requires at least one image URL', false);
    }

    const content: ContentPart[] = [{ type: 'text', text: SYSTEM_PROMPT }];
    for (const url of imageUrls) {
      content.push({ type: 'image_url', image_url: { url } });
    }

    let raw: string;
    try {
      const result = await this.chat([{ role: 'user', content }]);
      raw = result.content;
    } catch (error) {
      // Upstream model/transport failure: do not fall back to the offline
      // stub, fail closed so callers know no real extraction happened.
      const message = error instanceof Error ? error.message : String(error);
      throw new CommerceError('VLM_UNAVAILABLE', `vision model call failed: ${message}`, true);
    }

    const parsed = this.parseJson(raw);
    const title = asNonEmptyString(parsed.title, 'title');
    const sellingPoints = asStringArray(parsed.sellingPoints);
    const description = asNonEmptyString(parsed.description, 'description');

    return {
      title,
      sellingPoints,
      description,
      evidenceRefs: [...imageUrls],
    };
  }

  /** Tolerate models that wrap JSON in fences despite the instruction. */
  private parseJson(raw: string): VlmExtraction {
    const trimmed = raw.trim();
    const candidates = [trimmed, trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as VlmExtraction;
      } catch {
        // try next shape
      }
    }
    throw new CommerceError('VLM_BAD_PAYLOAD', 'VLM response was not valid JSON', false);
  }
}

export interface VlmIngestConfig {
  /** When false/undefined, online ingest must fail closed rather than stub. */
  enabled: boolean;
  hubUrl?: string;
  hubToken?: string;
  /** Text alias used for the vision call (must resolve to a VLM-capable model). */
  textAlias?: string;
}

/**
 * Build the online ingest port from env-like config. Returns a rejecting port
 * unless explicitly enabled with both hub URL and token, mirroring the GSC/
 * search connector discipline (no silent offline fallback).
 */
export function createOnlineListingIngest(config: VlmIngestConfig): ListingIngestPort {
  const { hubUrl, hubToken } = config;
  if (!config.enabled || !hubUrl || !hubToken) {
    return new RejectingOnlineListingIngest(
      'online listing ingest requires COMMERCE_VLM_ENABLED=true plus MODEL_HUB_URL and MODEL_HUB_TOKEN',
    );
  }
  const alias = config.textAlias ?? 'text';
  // Lazy ModelKit init keeps the model-kit dependency off the offline path and
  // avoids a network fetch during process bootstrap.
  let kitPromise: ReturnType<typeof initKit> | undefined;
  const chat: VlmChat = async (messages) => {
    kitPromise ??= initKit(hubUrl, hubToken);
    const kit = await kitPromise;
    return kit.chat(alias, messages);
  };
  return new VlmListingIngest(chat);
}

async function initKit(hubUrl: string, hubToken: string) {
  const { initModelKit } = await import('@model-hub/model-kit');
  return initModelKit({
    hubUrl,
    token: hubToken,
    cachePath: process.env.COMMERCE_MODELKIT_CACHE ?? './data/modelkit-cache.json',
  });
}

/** Local rejecting port (avoids a circular import from listing-ingest.ts). */
class RejectingOnlineListingIngest implements ListingIngestPort {
  readonly name = 'listing-ingest-rejecting';
  readonly mode = 'online' as const;

  constructor(private readonly message: string) {}

  ingest(): Promise<never> {
    return Promise.reject(new CommerceError('CREDENTIAL_MISSING', this.message, false));
  }
}
