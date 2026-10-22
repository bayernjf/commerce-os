import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ZeusDecisionClient } from '../src/decision/zeus-decision-client.js';
import { FakeZeusServer } from './helpers/fake-zeus-server.js';

describe('decision kernel integration (T-M3-06) over real zeus-client HTTP', () => {
  let zeus: FakeZeusServer;
  let client: ZeusDecisionClient;

  beforeEach(async () => {
    zeus = new FakeZeusServer();
    const url = await zeus.start();
    client = new ZeusDecisionClient({ baseUrl: url, token: zeus.token });
  });
  afterEach(async () => zeus.stop());

  it('external publish grades D3 and is held', async () => {
    const decision = await client.decide({
      intent: 'product.publish',
      domain: 'commerce',
      impact: 'external',
      reversibility: 'irreversible',
    });
    expect(decision.grade).toBe('D3');
    expect(decision.status).toBe('awaiting_approval');
    expect(decision.decisionId).toMatch(/^dec_fake_/);
  });

  it('1200 CNY refund grades D2 and is held', async () => {
    const decision = await client.decide({
      intent: 'order.refund',
      domain: 'commerce',
      amount: { value: 1200, currency: 'CNY' },
      impact: 'org',
      reversibility: 'hard',
    });
    expect(decision.grade).toBe('D2');
    expect(decision.status).toBe('awaiting_approval');
  });

  it('small 120 CNY refund grades D1', async () => {
    const decision = await client.decide({
      intent: 'order.refund',
      domain: 'commerce',
      amount: { value: 120, currency: 'CNY' },
      impact: 'org',
    });
    expect(decision.grade).toBe('D1');
  });

  it('approve and reject drive the decision through the approval endpoint', async () => {
    const held = await client.decide({
      intent: 'order.refund',
      domain: 'commerce',
      amount: { value: 1200, currency: 'CNY' },
    });
    const approved = await client.approve(held.decisionId, 'tester', 'ok');
    expect(approved.status).toBe('decided');

    const held2 = await client.decide({
      intent: 'order.refund',
      domain: 'commerce',
      amount: { value: 1200, currency: 'CNY' },
    });
    const rejected = await client.reject(held2.decisionId, 'tester', 'no');
    expect(rejected.status).toBe('rejected');
  });

  it('fails closed with DECISION_UNAVAILABLE when the kernel is unreachable', async () => {
    const bad = new ZeusDecisionClient({ baseUrl: 'http://127.0.0.1:1', token: 'x', timeoutMs: 500 });
    await expect(
      bad.decide({ intent: 'order.refund', domain: 'commerce', amount: { value: 1, currency: 'CNY' } }),
    ).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE' });
  });
});
