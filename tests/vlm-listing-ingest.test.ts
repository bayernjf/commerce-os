import { describe, it, expect } from 'vitest';
import { VlmListingIngest, createOnlineListingIngest, type VlmChat } from '../src/publishing/vlm-listing-ingest.js';

function fakeChat(content: string): VlmChat {
  return async (messages) => {
    // Prove the adapter sends multimodal parts, not a plain text prompt.
    const first = messages[0];
    if (!first || !Array.isArray(first.content)) {
      throw new Error('expected multimodal content array');
    }
    expect(first.content.some((p) => (p as { type: string }).type === 'image_url')).toBe(true);
    return { content };
  };
}

const input = {
  productId: 'prd_vlm',
  channel: 'sandbox-douyin',
  imageUrls: ['https://img.example.com/a.jpg', 'https://img.example.com/b.jpg'],
};

describe('VlmListingIngest (T-M9-01/J1 ingestFromImage)', () => {
  it('extracts strict JSON listing fields and records image evidence', async () => {
    const payload = JSON.stringify({
      title: '便携榨汁杯',
      sellingPoints: ['USB-C 充电', '一键清洗'],
      description: '小型便携，适合通勤',
    });
    const r = await new VlmListingIngest(fakeChat(payload)).ingest(input);
    expect(r.title).toBe('便携榨汁杯');
    expect(r.sellingPoints).toEqual(['USB-C 充电', '一键清洗']);
    expect(r.description).toBe('小型便携，适合通勤');
    expect(r.evidenceRefs).toEqual(input.imageUrls);
  });

  it('tolerates JSON wrapped in markdown fences', async () => {
    const fenced = '```json\n' + JSON.stringify({
      title: 'T',
      sellingPoints: ['p1'],
      description: 'd',
    }) + '\n```';
    const r = await new VlmListingIngest(fakeChat(fenced)).ingest(input);
    expect(r.title).toBe('T');
  });

  it('rejects non-JSON model output with VLM_BAD_PAYLOAD (no fabricated listing)', async () => {
    await expect(
      new VlmListingIngest(fakeChat('not json at all')).ingest(input),
    ).rejects.toMatchObject({ code: 'VLM_BAD_PAYLOAD' });
  });

  it('rejects empty title and empty selling points', async () => {
    const bad = JSON.stringify({ title: '   ', sellingPoints: [], description: 'd' });
    await expect(new VlmListingIngest(fakeChat(bad)).ingest(input)).rejects.toMatchObject({
      code: 'VLM_BAD_PAYLOAD',
    });
  });

  it('fails with VLM_NO_IMAGE when no image URL is supplied', async () => {
    const adapter = new VlmListingIngest(fakeChat('{}'));
    await expect(adapter.ingest({ productId: 'p', channel: 'c' })).rejects.toMatchObject({
      code: 'VLM_NO_IMAGE',
    });
  });

  it('maps an upstream model failure to retryable VLM_UNAVAILABLE, never the offline stub', async () => {
    const failing: VlmChat = async () => {
      throw new Error('network down');
    };
    await expect(new VlmListingIngest(failing).ingest(input)).rejects.toMatchObject({
      code: 'VLM_UNAVAILABLE',
      retryable: true,
    });
  });
});

describe('createOnlineListingIngest fail-closed discipline', () => {
  it('returns a rejecting port when disabled', () => {
    const port = createOnlineListingIngest({ enabled: false, hubUrl: 'u', hubToken: 't' });
    expect(port.mode).toBe('online');
    expect(port.name).toBe('listing-ingest-rejecting');
  });

  it('returns a rejecting port when hub config is incomplete', () => {
    const port = createOnlineListingIngest({ enabled: true, hubUrl: 'u' });
    expect(port.name).toBe('listing-ingest-rejecting');
  });

  it('rejecting port fails with CREDENTIAL_MISSING', async () => {
    const port = createOnlineListingIngest({ enabled: false });
    await expect(port.ingest(input)).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' });
  });

  it('builds a VLM port when fully enabled (chat is lazily initialised)', () => {
    const port = createOnlineListingIngest({
      enabled: true,
      hubUrl: 'https://hub.test',
      hubToken: 'tok',
      textAlias: 'text',
    });
    expect(port.name).toBe('listing-ingest-vlm');
  });
});
