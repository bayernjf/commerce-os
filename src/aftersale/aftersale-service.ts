import type { StorageDriver } from '../storage/driver.js';
import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';
import type { EventLog } from '../storage/event-log.js';
import type { DecisionPort } from '../decision/types.js';
import type { ChannelRegistry } from '../channel/registry.js';
import type { ChannelAccountService } from '../channel/channel-account-service.js';
import type { OrderService } from '../order/order-service.js';

export interface RefundLineInput {
  orderItemId?: string;
  skuId?: string;
  qty?: number;
  amount?: number;
}

export interface Refund {
  id: string;
  orderId: string;
  lines: { orderItemId: string; qty: number; amount: number }[];
  reason: string;
  status: 'requested' | 'awaiting_approval' | 'approved' | 'succeeded' | 'rejected' | 'failed';
  decisionId?: string;
  externalRefundRef?: string;
  createdAt: string;
  decidedAt?: string;
}

/**
 * After-sale center. Refunds are money-out, so the channel refund call is
 * NEVER made until zeus has recorded an approval. Rejections are recorded
 * as audit events; nothing reaches the channel.
 */
export class AftersaleService {
  constructor(
    private readonly driver: StorageDriver,
    private readonly events: EventLog,
    private readonly decisions: DecisionPort,
    private readonly registry: ChannelRegistry,
    private readonly accounts: ChannelAccountService,
    private readonly orders: OrderService,
  ) {}

  async requestRefund(orderId: string, input: { lines: RefundLineInput[]; reason: string }): Promise<Refund> {
    if (!input.reason?.trim()) throw new CommerceError('VALIDATION_FAILED', 'refund.reason is required');
    const order = await this.orders.getOrder(orderId);
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new CommerceError('VALIDATION_FAILED', 'refund requires at least one line');
    }

    // Resolve and validate lines against the persisted order; amounts are
    // always computed from stored order data, never from client input.
    const lines = input.lines.map((lineInput) => {
      const orderItem = order.lines.find((l) => l.id === lineInput.orderItemId);
      if (!orderItem) {
        throw new CommerceError('NOT_FOUND', `order item not found on this order: ${lineInput.orderItemId ?? '(missing)'}`, false, {
          orderId,
          orderItemId: lineInput.orderItemId,
        });
      }
      const qty = lineInput.qty ?? orderItem.qty;
      if (!Number.isInteger(qty) || qty <= 0 || qty > orderItem.qty) {
        throw new CommerceError('VALIDATION_FAILED', `invalid refund qty for ${orderItem.id}`, false, { qty, max: orderItem.qty });
      }
      const amount = Math.round((orderItem.price * qty) * 100) / 100;
      return { orderItemId: orderItem.id, qty, amount };
    });
    const total = Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;

    const now = nowIso();
    const refund: Refund = {
      id: newId('rfd', order.externalOrderId),
      orderId,
      lines,
      reason: input.reason.trim(),
      status: 'requested',
      createdAt: now,
    };
    await this.driver.run(
      `INSERT INTO refunds (id, order_id, lines_json, reason, status, decision_id, external_refund_ref, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [refund.id, refund.orderId, JSON.stringify(lines), refund.reason, refund.status, null, null, refund.createdAt, null],
    );

    const decision = await this.decisions.decide({
      intent: 'order.refund',
      domain: 'commerce',
      amount: { value: total, currency: order.currency },
      impact: 'org',
      reversibility: 'hard',
      riskTags: ['aftersale', 'refund'],
      proposal: `refund ${total} ${order.currency} for order ${order.externalOrderId} (${refund.reason})`,
      idempotencyKey: `refund:${refund.id}`,
    });
    await this.events.record({
      eventType: 'decision.requested',
      refType: 'refund',
      refId: refund.id,
      decisionId: decision.decisionId,
      payload: { orderId, total, grade: decision.grade, status: decision.status },
    });

    if (decision.status === 'decided') {
      // Auto-approved grade (D0/D1 inline settled): proceed to the channel.
      await this.driver.run('UPDATE refunds SET status = ?, decision_id = ?, decided_at = ? WHERE id = ?', [
        'approved', decision.decisionId, nowIso(), refund.id,
      ]);
      const succeeded = await this.executeChannelRefund(refund, order, decision.decisionId);
      return succeeded;
    }

    // Held: park and wait for an approval.
    await this.driver.run('UPDATE refunds SET status = ?, decision_id = ? WHERE id = ?', [
      'awaiting_approval', decision.decisionId, refund.id,
    ]);
    await this.events.record({
      eventType: 'refund.awaiting_approval',
      refType: 'refund',
      refId: refund.id,
      decisionId: decision.decisionId,
      payload: { grade: decision.grade, mode: decision.mode },
    });
    return { ...refund, status: 'awaiting_approval', decisionId: decision.decisionId };
  }

  async decideRefund(refundId: string, verdict: 'approve' | 'reject', approver: string, comment?: string): Promise<Refund> {
    const refund = await this.getRefund(refundId);
    if (refund.status !== 'awaiting_approval') {
      throw new CommerceError('CONFLICT', `refund is not awaiting approval: ${refund.status}`, false, { status: refund.status });
    }
    if (!refund.decisionId) throw new CommerceError('CONFLICT', 'refund has no decision id');

    const decision = verdict === 'approve'
      ? await this.decisions.approve(refund.decisionId, approver, comment)
      : await this.decisions.reject(refund.decisionId, approver, comment);

    if (verdict === 'reject' || decision.status === 'rejected') {
      await this.driver.run('UPDATE refunds SET status = ?, decided_at = ? WHERE id = ?', ['rejected', nowIso(), refund.id]);
      await this.events.record({
        eventType: 'refund.rejected',
        refType: 'refund',
        refId: refund.id,
        decisionId: refund.decisionId,
        payload: { approver, comment: comment ?? null },
      });
      return this.getRefund(refundId);
    }

    await this.driver.run('UPDATE refunds SET status = ?, decided_at = ? WHERE id = ?', ['approved', nowIso(), refund.id]);
    const order = await this.orders.getOrder(refund.orderId);
    return this.executeChannelRefund(refund, order, refund.decisionId);
  }

  private async executeChannelRefund(refund: Refund, order: Awaited<ReturnType<OrderService['getOrder']>>, decisionId: string): Promise<Refund> {
    if (!order.channelAccountId) {
      throw new CommerceError('VALIDATION_FAILED', `order ${order.id} has no channel account`);
    }
    const account = await this.accounts.get(order.channelAccountId);
    const adapter = this.registry.get(account.channel);
    const result = await adapter.createRefund({
      externalOrderId: order.externalOrderId,
      lines: refund.lines.map((l) => {
        const orderItem = order.lines.find((ol) => ol.id === l.orderItemId);
        return {
          ...(orderItem?.externalItemId ? { externalItemId: orderItem.externalItemId } : {}),
          ...(orderItem?.externalSkuCode ? { externalSkuCode: orderItem.externalSkuCode } : {}),
          qty: l.qty,
          amount: l.amount,
        };
      }),
      reason: refund.reason,
    });
    if (result.status === 'rejected') {
      await this.driver.run('UPDATE refunds SET status = ?, external_refund_ref = ?, decided_at = ? WHERE id = ?', [
        'failed', result.externalRefundId, nowIso(), refund.id,
      ]);
      await this.events.record({
        eventType: 'refund.failed',
        refType: 'refund',
        refId: refund.id,
        decisionId,
        payload: { externalRefundId: result.externalRefundId, channel: result.channel },
      });
      return this.getRefund(refund.id);
    }
    await this.driver.run('UPDATE refunds SET status = ?, external_refund_ref = ?, decided_at = ? WHERE id = ?', [
      'succeeded', result.externalRefundId, nowIso(), refund.id,
    ]);
    await this.events.record({
      eventType: 'refund.succeeded',
      refType: 'refund',
      refId: refund.id,
      decisionId,
      payload: { externalRefundId: result.externalRefundId, channel: result.channel },
    });
    return this.getRefund(refund.id);
  }

  async getRefund(id: string): Promise<Refund> {
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM refunds WHERE id = ?', [id]);
    if (!row) throw new CommerceError('NOT_FOUND', `refund not found: ${id}`, false, { refundId: id });
    return this.mapRefund(row);
  }

  /** Read-only list, newest rows last (same order as the other domain lists). */
  async listRefunds(): Promise<Refund[]> {
    const rows = await this.driver.all<Record<string, unknown>>('SELECT id FROM refunds ORDER BY created_at ASC', []);
    const refunds: Refund[] = [];
    for (const r of rows) refunds.push(await this.getRefund(String(r.id)));
    return refunds;
  }

  private mapRefund(row: Record<string, unknown>): Refund {
    let lines: Refund['lines'] = [];
    try {
      lines = JSON.parse(String(row.lines_json)) as Refund['lines'];
    } catch {
      lines = [];
    }
    return {
      id: String(row.id),
      orderId: String(row.order_id),
      lines,
      reason: String(row.reason),
      status: row.status as Refund['status'],
      ...(row.decision_id ? { decisionId: String(row.decision_id) } : {}),
      ...(row.external_refund_ref ? { externalRefundRef: String(row.external_refund_ref) } : {}),
      createdAt: String(row.created_at),
      ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    };
  }
}
