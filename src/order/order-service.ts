import type { StorageDriver } from '../storage/driver.js';
import { CommerceError } from '../util/errors.js';
import { newId, nowIso } from '../util/ids.js';
import type { EventLog } from '../storage/event-log.js';
import type { ChannelRegistry } from '../channel/registry.js';
import type { ChannelAccountService } from '../channel/channel-account-service.js';

export interface OrderLine {
  id: string;
  externalItemId: string;
  externalSkuCode?: string;
  skuId?: string;
  title: string;
  qty: number;
  price: number;
}

export interface Order {
  id: string;
  channel: string;
  externalOrderId: string;
  channelAccountId?: string;
  status: 'imported' | 'paid' | 'fulfilling' | 'completed' | 'refunded' | 'closed';
  totalAmount: number;
  currency: string;
  buyerRef?: string;
  lines: OrderLine[];
  createdAt: string;
  importedAt: string;
}

export interface ImportResult {
  imported: Order[];
  skipped: { externalOrderId: string; reason: string }[];
}

/**
 * Order center: pull orders from a channel adapter and persist them
 * idempotently (channel + externalOrderId unique). Re-importing the same
 * orders returns them as skipped, never duplicated.
 */
export class OrderService {
  constructor(
    private readonly driver: StorageDriver,
    private readonly registry: ChannelRegistry,
    private readonly accounts: ChannelAccountService,
    private readonly events?: EventLog,
  ) {}

  async importFromChannel(channelAccountId: string, since?: string): Promise<ImportResult> {
    const account = await this.accounts.get(channelAccountId);
    const adapter = this.registry.get(account.channel);
    const channelOrders = await adapter.listOrders(since ? { since } : {});

    const imported: Order[] = [];
    const skipped: ImportResult['skipped'] = [];

    for (const channelOrder of channelOrders) {
      const existing = await this.driver.get<Record<string, unknown>>(
        'SELECT id FROM orders WHERE channel = ? AND external_order_id = ?',
        [account.channel, channelOrder.externalOrderId],
      );
      if (existing) {
        skipped.push({ externalOrderId: channelOrder.externalOrderId, reason: 'already imported (idempotent)' });
        continue;
      }

      const now = nowIso();
      const order: Order = {
        id: newId('ord', channelOrder.externalOrderId),
        channel: account.channel,
        externalOrderId: channelOrder.externalOrderId,
        ...(account.id ? { channelAccountId: account.id } : {}),
        status: channelOrder.status === 'paid' ? 'paid' : 'imported',
        totalAmount: channelOrder.totalAmount,
        currency: channelOrder.currency,
        ...(channelOrder.buyerRef ? { buyerRef: channelOrder.buyerRef } : {}),
        lines: [],
        createdAt: channelOrder.createdAt,
        importedAt: now,
      };
      await this.driver.run(
        `INSERT INTO orders (id, channel, external_order_id, channel_account_id, status, total_amount, currency, buyer_ref, created_at, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [order.id, order.channel, order.externalOrderId, order.channelAccountId ?? null, order.status, order.totalAmount, order.currency, order.buyerRef ?? null, order.createdAt, order.importedAt],
      );

      for (const line of channelOrder.lines) {
        const skuRow = await this.driver.get<Record<string, unknown>>('SELECT id FROM skus WHERE sku_code = ?', [line.externalSkuCode]);
        const orderLine: OrderLine = {
          id: newId('itm', `${channelOrder.externalOrderId}-${line.externalItemId}`),
          externalItemId: line.externalItemId,
          ...(line.externalSkuCode ? { externalSkuCode: line.externalSkuCode } : {}),
          ...(skuRow ? { skuId: String(skuRow.id) } : {}),
          title: line.title,
          qty: line.qty,
          price: line.price,
        };
        order.lines.push(orderLine);
        await this.driver.run(
          `INSERT INTO order_items (id, order_id, sku_id, external_sku_code, title, qty, price) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [orderLine.id, order.id, orderLine.skuId ?? null, orderLine.externalSkuCode ?? null, orderLine.title, orderLine.qty, orderLine.price],
        );
      }
      imported.push(order);
    }
    if (this.events) {
      for (const order of imported) {
        await this.events.record({
          eventType: 'order.imported',
          refType: 'order',
          refId: order.id,
          payload: { channel: order.channel, externalOrderId: order.externalOrderId, totalAmount: order.totalAmount, currency: order.currency },
        });
      }
    }
    return { imported, skipped };
  }

  async getOrder(id: string): Promise<Order> {
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM orders WHERE id = ?', [id]);
    if (!row) throw new CommerceError('NOT_FOUND', `order not found: ${id}`, false, { orderId: id });
    const lineRows = await this.driver.all<Record<string, unknown>>('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [id]);
    return this.mapOrder(row, lineRows);
  }

  /** Resolve an order by its external reference (storefront: sf-{cartId}). */
  async getOrderByExternalId(externalOrderId: string): Promise<Order> {
    const row = await this.driver.get<Record<string, unknown>>('SELECT id FROM orders WHERE external_order_id = ?', [externalOrderId]);
    if (!row) {
      throw new CommerceError('NOT_FOUND', `order not found for external ref: ${externalOrderId}`, false, { externalOrderId });
    }
    return this.getOrder(String(row.id));
  }

  async listOrders(): Promise<Order[]> {
    const rows = await this.driver.all<Record<string, unknown>>('SELECT id FROM orders ORDER BY created_at ASC');
    const orders: Order[] = [];
    for (const r of rows) orders.push(await this.getOrder(String(r.id)));
    return orders;
  }

  async setStatus(id: string, status: Order['status']): Promise<void> {
    await this.driver.run('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
  }

  private mapOrder(r: Record<string, unknown>, lineRows: Record<string, unknown>[]): Order {
    return {
      id: String(r.id),
      channel: String(r.channel),
      externalOrderId: String(r.external_order_id),
      ...(r.channel_account_id ? { channelAccountId: String(r.channel_account_id) } : {}),
      status: r.status as Order['status'],
      totalAmount: Number(r.total_amount),
      currency: String(r.currency),
      ...(r.buyer_ref ? { buyerRef: String(r.buyer_ref) } : {}),
      createdAt: String(r.created_at),
      importedAt: String(r.imported_at),
      lines: lineRows.map((l) => ({
        id: String(l.id),
        externalItemId: String(l.external_item_id ?? l.external_sku_code ?? l.id),
        ...(l.external_sku_code ? { externalSkuCode: String(l.external_sku_code) } : {}),
        ...(l.sku_id ? { skuId: String(l.sku_id) } : {}),
        title: String(l.title),
        qty: Number(l.qty),
        price: Number(l.price),
      })),
    };
  }
}
