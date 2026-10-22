import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LoomContentClient } from '../src/content/loom-content-client.js';
import { FakeLoomServer } from './helpers/fake-loom-server.js';

describe('loom content-base client (T-M4-03) over real HTTP', () => {
  let loom: FakeLoomServer;
  let client: LoomContentClient;

  beforeEach(async () => {
    loom = new FakeLoomServer();
    const url = await loom.start();
    client = new LoomContentClient({ baseUrl: url, actorId: 'tester' });
  });
  afterEach(async () => loom.stop());

  it('requests a pending candidate from the content base', async () => {
    const candidate = await client.request({
      productId: 'sku-1',
      channel: 'douyin',
      contentType: 'detail',
      inputs: { title: 'T恤' },
      constraints: { banned: ['最'] },
    });
    expect(candidate.source).toBe('content-base');
    expect(candidate.status).toBe('pending_review');
    expect(candidate.id).toMatch(/^loom_fake_/);
    expect(candidate.evidenceRefs).toContain('llm:agnes-3.0-flash');
  });

  it('review confirms the candidate', async () => {
    const pending = await client.request({
      productId: 'sku-1',
      channel: 'douyin',
      contentType: 'detail',
      inputs: {},
    });
    const confirmed = await client.review(pending.id, 'confirmed');
    expect(confirmed.status).toBe('confirmed');
  });

  it('maps 404 to NOT_FOUND', async () => {
    await expect(
      client.review('missing', 'confirmed'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps 5xx to CONTENT_UNAVAILABLE and retryable', async () => {
    loom.failRequestsWith = 500;
    await expect(
      client.request({ productId: 's', channel: 'douyin', contentType: 'qa', inputs: {} }),
    ).rejects.toMatchObject({ code: 'CONTENT_UNAVAILABLE', retryable: true });
  });

  it('fails closed with CONTENT_UNAVAILABLE when loom is unreachable', async () => {
    const bad = new LoomContentClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    await expect(
      bad.request({ productId: 's', channel: 'douyin', contentType: 'qa', inputs: {} }),
    ).rejects.toMatchObject({ code: 'CONTENT_UNAVAILABLE' });
  });
});
