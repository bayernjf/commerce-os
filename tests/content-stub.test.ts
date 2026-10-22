import { describe, it, expect } from 'vitest';
import { StubContentClient } from '../src/content/stub-content-client.js';

describe('content stub (T-M3-07)', () => {
  it('produces a pending-review candidate and never auto-confirms', async () => {
    const content = new StubContentClient();
    const candidate = await content.request({
      productId: 'prd_1',
      channel: 'sandbox-douyin',
      contentType: 'detail',
      inputs: { title: '演示商品', sellingPoints: ['卖点A', '卖点B'] },
    });
    expect(candidate.status).toBe('pending_review');
    expect(candidate.body.text).toContain('卖点A');
    expect(candidate.source).toBe('stub');
  });

  it('refuses banned words (constraint enforcement is exercised)', async () => {
    const content = new StubContentClient();
    await expect(
      content.request({
        productId: 'prd_1',
        channel: 'sandbox-douyin',
        contentType: 'detail',
        inputs: { title: '神器 全网第一' },
        constraints: { banned: ['第一'] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('allows confirmed/modified/rejected review exactly once', async () => {
    const content = new StubContentClient();
    const c1 = await content.request({ productId: 'p', channel: 'sandbox-douyin', contentType: 'post', inputs: { title: 't' } });
    const confirmed = await content.review(c1.id, 'confirmed');
    expect(confirmed.status).toBe('confirmed');
    await expect(content.review(c1.id, 'rejected')).rejects.toMatchObject({ code: 'CONFLICT' });

    const c2 = await content.request({ productId: 'p', channel: 'sandbox-douyin', contentType: 'post', inputs: { title: 't' } });
    const modified = await content.review(c2.id, 'modified', { title: 't2', text: 'edited' });
    expect(modified.body.text).toBe('edited');
  });
});
