import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupHarness, teardownHarness, type TestHarness } from './helpers/harness.js';
import { newId, nowIso } from '../src/util/ids.js';

async function insertOrder(h: TestHarness, totalAmount: number): Promise<string> {
  const id = newId('ord');
  await h.driver.run(
    `INSERT INTO orders (id, channel, external_order_id, channel_account_id, status, total_amount, currency, buyer_ref, created_at, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 'sandbox-douyin', `ext-${id}`, null, 'paid', totalAmount, 'CNY', null, nowIso(), nowIso()],
  );
  return id;
}

async function agentMessageCount(h: TestHarness, conversationId: string): Promise<number> {
  const rows = await h.driver.all<{ role: string }>(
    'SELECT role FROM cs_messages WHERE conversation_id = ?',
    [conversationId],
  );
  return rows.filter((r) => r.role === 'agent').length;
}

describe('customer service (T-M4-04)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => teardownHarness(h));

  it('product inquiry grades D0 and auto-sends', async () => {
    const conv = await h.services.customerService.openConversation({ channel: 'sandbox-douyin' });
    const candidate = await h.services.customerService.handleMessage(conv.id, '这个衣服什么材质？');
    expect(candidate.intent).toBe('product_inquiry');
    expect(candidate.grade).toBe('D0');
    expect(candidate.status).toBe('auto_sent');
  });

  it('logistics inquiry grades D0 and auto-sends', async () => {
    const conv = await h.services.customerService.openConversation({ channel: 'sandbox-douyin' });
    const candidate = await h.services.customerService.handleMessage(conv.id, '我的快递到哪了？');
    expect(candidate.grade).toBe('D0');
    expect(candidate.status).toBe('auto_sent');
  });

  it('commitment request grades D3 and is held for a human (no auto commitment)', async () => {
    const conv = await h.services.customerService.openConversation({ channel: 'sandbox-douyin' });
    const candidate = await h.services.customerService.handleMessage(conv.id, '你能保证明天一定送到吗？');
    expect(candidate.grade).toBe('D3');
    expect(candidate.status).toBe('awaiting_human');
    expect(candidate.decisionId).toBeTruthy();
    // No agent message is auto-created for a high-risk commitment.
    expect(await agentMessageCount(h, conv.id)).toBe(0);
  });

  it('refund without an order is held D2 (amount unverifiable)', async () => {
    const conv = await h.services.customerService.openConversation({ channel: 'sandbox-douyin' });
    const candidate = await h.services.customerService.handleMessage(conv.id, '我要退款');
    expect(candidate.grade).toBe('D2');
    expect(candidate.status).toBe('awaiting_human');
  });

  it('refund against a large order grades D2 and is held', async () => {
    const orderId = await insertOrder(h, 1299);
    const conv = await h.services.customerService.openConversation({
      channel: 'sandbox-douyin',
      orderId,
    });
    const candidate = await h.services.customerService.handleMessage(conv.id, '申请退款');
    expect(candidate.grade).toBe('D2');
    expect(candidate.status).toBe('awaiting_human');
  });

  it('refund against a small order grades D1 and auto-sends an informational reply', async () => {
    const orderId = await insertOrder(h, 120);
    const conv = await h.services.customerService.openConversation({
      channel: 'sandbox-douyin',
      orderId,
    });
    const candidate = await h.services.customerService.handleMessage(conv.id, '我要退款');
    expect(candidate.grade).toBe('D1');
    expect(candidate.status).toBe('auto_sent');
    expect(candidate.replyText).toContain('已登记');
  });

  it('a human reply is recorded as sent_by_human', async () => {
    const conv = await h.services.customerService.openConversation({ channel: 'sandbox-douyin' });
    const candidate = await h.services.customerService.humanReply(conv.id, '我来人工跟进');
    expect(candidate.status).toBe('sent_by_human');
  });
});
