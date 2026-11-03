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
  idempotencyKey?: string;
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

  async requestRefund(orderId: string, input: { lines: RefundLineInput[]; reason: string; idempotencyKey?: string }): Promise<Refund> {
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
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      createdAt: now,
    };
    // Cumulative guard (P1): reserve qty/amount per order line via a conditional
    // upsert. The database is the only admission gate — two concurrent requests
    // cannot both pass, and the small auto-refund path is covered identically.
    await this.reserveLines(refund, order);
    try {
      await this.driver.run(
        `INSERT INTO refunds (id, order_id, lines_json, reason, status, decision_id, external_refund_ref, created_at, decided_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [refund.id, refund.orderId, JSON.stringify(lines), refund.reason, refund.status, null, null, refund.createdAt, null, input.idempotencyKey ?? null],
      );
    } catch (error) {
      // The reservation is only valid alongside its refund row; release on any
      // insert failure, then replay idempotently if the key simply collided.
      await this.releaseLines(lines);
      if (input.idempotencyKey && this.isUniqueViolation(error)) {
        return this.getRefundByIdempotencyKey(input.idempotencyKey);
      }
      throw error;
    }

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
      // Rejection never moves money, so the reserved quantity is handed back.
      await this.releaseLines(refund.lines);
      await this.events.record({
        eventType: 'refund.rejected',
        refType: 'refund',
        refId: refund.id,
        decisionId: refund.decisionId,
        payload: { approver, comment: comment ?? null },
      });
      return this.getRefund(refundId);
    }

    // Fail closed on anything but a settled approval: a held/blocked/unknown
    // status must never reach the channel (review 2026-11-02 P2-1).
    if (decision.status !== 'decided') {
      throw new CommerceError('CONFLICT', `refund decision is not approved: ${decision.status}`, false, {
        decisionId: refund.decisionId,
        status: decision.status,
      });
    }

    // Concurrent approvals must not both reach the channel: claim the refund by
    // flipping the state exactly once. The loser sees 0 changes and stops here.
    const claim = await this.driver.run(
      `UPDATE refunds SET status = ?, decided_at = ? WHERE id = ? AND status = 'awaiting_approval'`,
      ['approved', nowIso(), refund.id],
    );
    if (claim.changes === 0) {
      throw new CommerceError('CONFLICT', `refund was already decided by a concurrent request: ${refund.id}`, false, { refundId: refund.id });
    }
    const order = await this.orders.getOrder(refund.orderId);
    return this.executeChannelRefund(refund, order, refund.decisionId);
  }

  private async executeChannelRefund(refund: Refund, order: Awaited<ReturnType<OrderService['getOrder']>>, decisionId: string): Promise<Refund> {
    if (!order.channelAccountId && order.channel !== 'storefront') {
      throw new CommerceError('VALIDATION_FAILED', `order ${order.id} has no channel account`);
    }
    // Storefront self-operated sales carry no channel account in the
    // local/dev form: refunds settle through the registered 'storefront'
    // fake payout adapter (real providers land with LF-07).
    const account = order.channelAccountId ? await this.accounts.get(order.channelAccountId) : null;
    const adapter = this.registry.get(account?.channel ?? order.channel);
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
      // The channel explicitly refused to pay: nothing moved, reservation released.
      await this.releaseLines(refund.lines);
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

  /** Refunds for one order, newest first (shopper-facing order status page). */
  async listRefundsForOrder(orderId: string): Promise<Refund[]> {
    const rows = await this.driver.all<Record<string, unknown>>(
      'SELECT id FROM refunds WHERE order_id = ? ORDER BY created_at DESC',
      [orderId],
    );
    const refunds: Refund[] = [];
    for (const r of rows) refunds.push(await this.getRefund(String(r.id)));
    return refunds;
  }

  /**
   * Cumulative admission gate: one conditional upsert per line. On the first
   * refund for a line it inserts the usage row; afterwards it only increments
   * while `refunded_qty/amount + this refund` stays within the purchased
   * qty/amount. SQLite serializes writers and Postgres takes a row lock on
   * conflict, so concurrent requests cannot both pass. Any prior reservation
   * made for this same refund is rolled back before the error propagates.
   */
  private async reserveLines(refund: Refund, order: Awaited<ReturnType<OrderService['getOrder']>>): Promise<void> {
    const reserved: Refund['lines'] = [];
    try {
      for (const line of refund.lines) {
        const orderItem = order.lines.find((l) => l.id === line.orderItemId);
        if (!orderItem) throw new CommerceError('NOT_FOUND', `order item not found on this order: ${line.orderItemId}`);
        const maxAmountCents = Math.round(orderItem.price * orderItem.qty * 100);
        const amountCents = Math.round(line.amount * 100);
        const result = await this.driver.run(
          `INSERT INTO refund_line_usage (order_item_id, refunded_qty, refunded_amount_cents, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(order_item_id) DO UPDATE SET
             refunded_qty = refunded_qty + excluded.refunded_qty,
             refunded_amount_cents = refunded_amount_cents + excluded.refunded_amount_cents,
             updated_at = excluded.updated_at
           WHERE refund_line_usage.refunded_qty + excluded.refunded_qty <= ?
             AND refund_line_usage.refunded_amount_cents + excluded.refunded_amount_cents <= ?`,
          [line.orderItemId, line.qty, amountCents, nowIso(), orderItem.qty, maxAmountCents],
        );
        if (result.changes === 0) {
          throw new CommerceError('CONFLICT', `refund exceeds refundable quantity for order item ${line.orderItemId}`, false, {
            orderItemId: line.orderItemId,
            requestedQty: line.qty,
            maxQty: orderItem.qty,
          });
        }
        reserved.push(line);
      }
    } catch (error) {
      await this.releaseLines(reserved);
      if (error instanceof CommerceError && error.code === 'CONFLICT') {
        await this.events.record({
          eventType: 'refund.limit_exceeded',
          refType: 'refund',
          refId: refund.id,
          payload: { orderId: refund.orderId, lines: refund.lines },
        });
      }
      throw error;
    }
  }

  /** Hand reserved quantity/amount back (rejection, channel-refusal, or compensation). */
  private async releaseLines(lines: Refund['lines']): Promise<void> {
    for (const line of lines) {
      await this.driver.run(
        `UPDATE refund_line_usage
         SET refunded_qty = MAX(refunded_qty - ?, 0),
             refunded_amount_cents = MAX(refunded_amount_cents - ?, 0),
             updated_at = ?
         WHERE order_item_id = ?`,
        [line.qty, Math.round(line.amount * 100), nowIso(), line.orderItemId],
      );
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    return message.includes('UNIQUE constraint failed') || code === '23505';
  }

  private async getRefundByIdempotencyKey(key: string): Promise<Refund> {
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM refunds WHERE idempotency_key = ?', [key]);
    if (!row) throw new CommerceError('NOT_FOUND', `refund not found for idempotency key`, false, {});
    return this.mapRefund(row);
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
      ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}),
      createdAt: String(row.created_at),
      ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    };
  }
}
